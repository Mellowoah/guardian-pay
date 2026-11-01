import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_URL, setup, newCase, fundedMilestone, toVerified, type Env } from './helpers.js';
import { IllegalTransition } from '../src/state.js';
import { HttpError } from '../src/repo.js';
import { clock } from '../src/clock.js';
import { lifecycleTick } from '../src/lifecycle.js';
import { reconcileEvent } from '../src/reconcile.js';

const opts = { skip: TEST_URL ? false : 'DATABASE_URL_TEST not set' };
const code = async (p: Promise<unknown>) => { try { await p; return 'no-error'; } catch (e) { return e instanceof HttpError ? `${e.status}:${e.code}` : e instanceof IllegalTransition ? '409:illegal_transition' : `x:${(e as Error).message}`; } };
const auditRows = async (e: Env, caseId: string) => (await e.db.query('SELECT actor, action, before, after FROM audit_log WHERE case_id = $1 ORDER BY id', [caseId])).rows;
const pay = async (e: Env, id: string) => (await e.db.query('SELECT * FROM payments WHERE milestone_id = $1', [id])).rows[0];
const state = async (e: Env, id: string) => (await e.db.query('SELECT state FROM milestones WHERE id = $1', [id])).rows[0].state;
let n = 0;
const event = async (e: Env, type: string, resource: any) => {
  const id = `WH-${Date.now()}-${++n}`;
  await e.db.query('INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload) VALUES ($1,$2,true,$3)', [id, type, JSON.stringify({ id, event_type: type, resource })]);
  return id;
};

describe('db: migrations and audit log', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { await e.close(); });
  test('migrations are idempotent and create every table', async () => {
    const { migrate } = await import('../src/migrations.js');
    assert.deepEqual(await migrate(e.db), []);
    const t = (await e.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`)).rows.map(r => r.table_name);
    for (const x of ['users', 'providers', 'cases', 'milestones', 'payments', 'approvals', 'webhook_events', 'audit_log', 'mandates']) assert.ok(t.includes(x), x);
  });
  test('audit_log is append-only (UPDATE, DELETE, TRUNCATE rejected)', async () => {
    const c = await newCase(e);
    await assert.rejects(e.db.query(`UPDATE audit_log SET actor = 'x' WHERE case_id = $1`, [c.id]), /append-only/i);
    await assert.rejects(e.db.query(`DELETE FROM audit_log WHERE case_id = $1`, [c.id]), /append-only/i);
    await assert.rejects(e.db.query(`TRUNCATE audit_log`), /append-only/i);
  });
  test('illegal state values rejected by the database too', async () => {
    const c = await newCase(e);
    await assert.rejects(e.db.query(`UPDATE milestones SET state = 'bogus' WHERE id = $1`, [c.milestones[0].id]));
  });
});

describe('db: happy path, double-click, reject, roles', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { await e.close(); });

  test('happy path writes exactly one audit row per transition and stores both authorization ids', async () => {
    const f = await toVerified(e);
    const r = await e.svc.approve(e.family, f.id);
    assert.equal(r.milestone.state, 'captured'); assert.ok(r.payment!.capture_id);
    const p = await pay(e, f.id);
    assert.equal(p.original_authorization_id, p.current_authorization_id);
    assert.equal(p.status, 'captured');
    assert.equal(+new Date(p.honor_until) - +new Date(p.authorized_at), 3 * 86400_000);
    assert.equal(+new Date(p.expires_at) - +new Date(p.authorized_at), 29 * 86400_000);
    const rows = await auditRows(e, f.caseId);
    const trans = rows.filter(x => x.action.startsWith('milestone.') && x.action !== 'milestone.created').map(x => x.after.state);
    assert.deepEqual(trans, ['authorized', 'proof_submitted', 'verified', 'captured']);
    for (const x of rows.filter(x => x.action.startsWith('milestone.') && x.action !== 'milestone.created')) assert.ok(x.actor && x.before?.state);
    assert.ok(rows.some(x => x.action === 'approval.approve'));
  });

  test('double-click approve: concurrent calls produce ONE capture', async () => {
    const f = await toVerified(e); const before = e.fake.realCaptures;
    const [a, b, c] = await Promise.all([e.svc.approve(e.family, f.id), e.svc.approve(e.family, f.id), e.svc.approve(e.family, f.id)]);
    assert.equal(e.fake.realCaptures - before, 1);
    assert.equal(a.payment!.capture_id, b.payment!.capture_id); assert.equal(b.payment!.capture_id, c.payment!.capture_id);
    assert.equal((await e.svc.approve(e.family, f.id)).milestone.state, 'captured');
    const rows = await auditRows(e, f.caseId);
    assert.equal(rows.filter(x => x.action === 'milestone.captured').length, 1);
    assert.equal(rows.filter(x => x.action === 'approval.approve').length, 1);
  });

  test('capture request id is deterministic: same key on every approve call', async () => {
    const f = await toVerified(e); const n0 = e.fake.captureCalls.length;
    await Promise.all([e.svc.approve(e.family, f.id), e.svc.approve(e.family, f.id)]);
    const ids = new Set(e.fake.captureCalls.slice(n0).map(c => c.requestId));
    assert.equal(ids.size, 1); assert.match([...ids][0]!, new RegExp(`^gp-${f.id}-capture-1$`));
  });

  test('reject: reason required, voids the ORIGINAL authorization once, double-click idempotent', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { note: 'meh' });
    assert.equal(await code(e.svc.reject(e.family, f.id, {})), '400:bad_request');
    const p0 = await pay(e, f.id);
    const voids0 = e.fake.calls.filter(c => c.path.endsWith('/void')).length;
    await Promise.all([e.svc.reject(e.family, f.id, { reason: 'wrong colour' }), e.svc.reject(e.family, f.id, { reason: 'wrong colour' })]);
    const again = await e.svc.reject(e.family, f.id, { reason: 'wrong colour' });
    assert.equal(again.milestone.state, 'voided'); assert.equal(again.idempotent, true);
    assert.equal(e.fake.auths.get(p0.original_authorization_id)!.status, 'VOIDED');
    assert.equal(new Set(e.fake.calls.filter(c => c.path.endsWith('/void')).slice(voids0).map(c => c.requestId)).size, 1);
    const rows = await auditRows(e, f.caseId);
    assert.deepEqual(rows.filter(x => x.action === 'milestone.rejected' || x.action === 'milestone.voided').map(x => x.action), ['milestone.rejected', 'milestone.voided']);
    assert.equal(rows.find(x => x.action === 'milestone.rejected')!.after.reason, 'wrong colour');
    assert.equal(await code(e.svc.approve(e.family, f.id)), '409:conflict');
  });

  test('provider cannot approve or reject its own milestone; approve before verify is a 409; nothing is captured', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { note: 'x' });
    const caps = e.fake.captureCalls.length;
    assert.equal(await code(e.svc.approve(e.provider, f.id)), '403:forbidden');
    assert.equal(await code(e.svc.reject(e.provider, f.id, { reason: 'self' })), '403:forbidden');
    assert.equal(await code(e.svc.approve(e.family, f.id)), '409:conflict'); // proof_submitted, not verified
    assert.equal(await code(e.svc.verifyProof(e.family, f.id, {})), '403:forbidden');
    assert.equal(await code(e.svc.submitProof(e.provider2, f.id, { note: 'x' })), '403:forbidden'); // other provider
    assert.equal(e.fake.captureCalls.length, caps);
    assert.equal(await state(e, f.id), 'proof_submitted');
  });

  test('illegal transitions are rejected (proof before funding; fund twice)', async () => {
    const c = await newCase(e); const id = c.milestones[0].id;
    assert.equal(await code(e.svc.submitProof(e.provider, id, { note: 'x' })), '409:illegal_transition');
    await e.svc.openOrder(e.family, id, { payment_source: 'card' });
    assert.equal(await code(e.svc.openOrder(e.family, id, { payment_source: 'card' })), '409:conflict');
  });

  test('capture without an approval row is impossible even if state is forced to verified in SQL', async () => {
    const f = await fundedMilestone(e);
    await e.db.query(`UPDATE milestones SET state = 'verified' WHERE id = $1`, [f.id]); // tamper
    const caps = e.fake.captureCalls.length;
    await assert.rejects(e.guarded.capture({ actor: e.family, milestone: { id: f.id, state: 'verified', providerUserId: -1 }, amount: '25.00', attempt: 1 }, (await pay(e, f.id)).current_authorization_id, 'USD'), /approval/i);
    assert.equal(e.fake.captureCalls.length, caps);
  });

  test('wallet path: order returns approve link; authorize before buyer approval is 409; after approval authorizes', async () => {
    const c = await newCase(e); const id = c.milestones[0].id;
    const o = await e.svc.openOrder(e.family, id, { payment_source: 'paypal' });
    assert.match(o.approve_url!, /^https:\/\/sandbox\.paypal\.test\/approve/);
    assert.equal((await e.svc.openOrder(e.family, id, { payment_source: 'paypal' })).approve_url, o.approve_url); // idempotent
    assert.equal(await code(e.svc.authorizeWallet(e.family, id)), '409:buyer_approval_required');
    e.fake.orders.get(o.payment.order_id!)!['approved' as 'auth'] = true as any;
    const a = await e.svc.authorizeWallet(e.family, id);
    assert.equal(a.milestone.state, 'authorized');
    assert.equal((await e.svc.authorizeWallet(e.family, id)).idempotent, true);
  });
});

describe('db: lifecycle (fake clock)', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { clock.setOffsetDays(0); await e.close(); });
  test('day 26: warns once and defers reauth (TOO_SOON); then reauthorizes once, keeping both ids; day 30 expires', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { note: 'x' });
    const orig = (await pay(e, f.id)).original_authorization_id;
    clock.setOffsetDays(26);
    const t1 = await lifecycleTick(e.db, e.guarded, { caseId: f.caseId });
    assert.equal(t1.warned, 1); assert.equal(t1.deferred, 1);
    const t1b = await lifecycleTick(e.db, e.guarded, { caseId: f.caseId });
    assert.equal(t1b.warned, 0);
    let rows = await auditRows(e, f.caseId);
    assert.equal(rows.filter(x => x.action === 'payment.expiry_warning').length, 1);
    assert.equal(rows.filter(x => x.action === 'payment.reauthorize_deferred').length, 1);
    e.fake.allowReauth = true;
    await e.db.query(`UPDATE payments SET attempts = attempts - 'reauthorize_next_try' WHERE milestone_id = $1`, [f.id]);
    const t2 = await lifecycleTick(e.db, e.guarded, { caseId: f.caseId });
    assert.equal(t2.reauthorized, 1);
    const p = await pay(e, f.id);
    assert.equal(p.original_authorization_id, orig); assert.notEqual(p.current_authorization_id, orig); assert.equal(p.reauth_count, 1); assert.ok(p.reauthorized_at);
    assert.equal(await state(e, f.id), 'proof_submitted');
    assert.equal((await lifecycleTick(e.db, e.guarded, { caseId: f.caseId })).reauthorized, 0); // once only
    clock.setOffsetDays(30);
    assert.equal((await lifecycleTick(e.db, e.guarded, { caseId: f.caseId })).expired, 1);
    assert.equal(await state(e, f.id), 'expired'); assert.equal((await pay(e, f.id)).status, 'expired');
    rows = await auditRows(e, f.caseId);
    assert.equal(rows.filter(x => x.action === 'milestone.expired').length, 1);
    assert.equal(await code(e.svc.approve(e.family, f.id)), '409:conflict');
    clock.setOffsetDays(0);
  });
  test('authorized milestone moves authorized -> reauthorized with one audit row', async () => {
    e.fake.allowReauth = true; clock.setOffsetDays(4);
    const f = await fundedMilestone(e);
    await e.db.query(`UPDATE payments SET authorized_at = authorized_at - interval '4 days', honor_until = honor_until - interval '4 days', expires_at = expires_at - interval '4 days' WHERE milestone_id = $1`, [f.id]);
    assert.equal((await lifecycleTick(e.db, e.guarded, { caseId: f.caseId })).reauthorized, 1);
    assert.equal(await state(e, f.id), 'reauthorized');
    assert.equal((await auditRows(e, f.caseId)).filter(x => x.action === 'milestone.reauthorized').length, 1);
    // a reauthorized milestone can still be captured using the NEW authorization id
    await e.svc.submitProof(e.provider, f.id, { note: 'x' }); await e.svc.verifyProof(e.reviewer, f.id, {});
    const r = await e.svc.approve(e.family, f.id);
    assert.equal(r.milestone.state, 'captured');
    assert.equal(e.fake.auths.get((await pay(e, f.id)).current_authorization_id)!.captures.length, 1);
    clock.setOffsetDays(0);
  });
});

describe('db: webhook reconciliation (PayPal wins)', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { await e.close(); });
  test('COMPLETED for our capture confirms it', async () => {
    const f = await toVerified(e); const r = await e.svc.approve(e.family, f.id);
    const out = await reconcileEvent(e.db, await event(e, 'PAYMENT.CAPTURE.COMPLETED', { id: r.payment!.capture_id, supplementary_data: { related_ids: { authorization_id: r.payment!.current_authorization_id } } }));
    assert.equal(out.outcome, 'confirmed'); assert.ok((await pay(e, f.id)).webhook_confirmed_at); assert.equal((await pay(e, f.id)).mismatch_flag, false);
    assert.equal((await auditRows(e, f.caseId)).filter(x => x.action === 'reconcile.confirmed').length, 1);
  });
  test('DECLINED after we recorded captured: PayPal wins, milestone back to verified, flagged', async () => {
    const f = await toVerified(e); const r = await e.svc.approve(e.family, f.id);
    const out = await reconcileEvent(e.db, await event(e, 'PAYMENT.CAPTURE.DECLINED', { id: r.payment!.capture_id }));
    assert.equal(out.outcome, 'mismatch'); assert.equal(await state(e, f.id), 'verified');
    const p = await pay(e, f.id); assert.equal(p.status, 'capture_failed'); assert.equal(p.mismatch_flag, true);
    const rows = await auditRows(e, f.caseId);
    assert.ok(rows.some(x => x.action === 'reconcile.override')); assert.ok(rows.some(x => x.action === 'reconcile.mismatch'));
  });
  test('COMPLETED for a milestone with no human approval is forced to captured AND flagged', async () => {
    const f = await fundedMilestone(e); const p = await pay(e, f.id);
    const out = await reconcileEvent(e.db, await event(e, 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-ROGUE', supplementary_data: { related_ids: { authorization_id: p.current_authorization_id } } }));
    assert.equal(out.outcome, 'mismatch'); assert.equal(await state(e, f.id), 'captured');
    assert.match((await pay(e, f.id)).mismatch_note, /NO recorded human approval/);
  });
  test('VOIDED outside Guardian Pay while holding: forced to voided and flagged; replays are skipped', async () => {
    const f = await fundedMilestone(e); const p = await pay(e, f.id);
    const evId = await event(e, 'PAYMENT.AUTHORIZATION.VOIDED', { id: p.current_authorization_id });
    assert.equal((await reconcileEvent(e.db, evId)).outcome, 'mismatch'); assert.equal(await state(e, f.id), 'voided');
    assert.equal((await reconcileEvent(e.db, evId)).outcome, 'skipped');
  });
  test('VOIDED after our own reject is a confirmation, not a mismatch', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { note: 'x' }); await e.svc.reject(e.family, f.id, { reason: 'no' });
    const p = await pay(e, f.id);
    assert.equal((await reconcileEvent(e.db, await event(e, 'PAYMENT.AUTHORIZATION.VOIDED', { id: p.original_authorization_id }))).outcome, 'confirmed');
    assert.equal((await pay(e, f.id)).mismatch_flag, false);
  });
  test('unrelated events are marked processed without touching anything', async () => {
    const id = await event(e, 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-UNKNOWN' });
    await e.db.query(`UPDATE webhook_events SET received_at = now() - interval '1 hour' WHERE paypal_event_id = $1`, [id]);
    assert.equal((await reconcileEvent(e.db, id)).outcome, 'unmatched');
    assert.ok((await e.db.query('SELECT processed_at FROM webhook_events WHERE paypal_event_id = $1', [id])).rows[0].processed_at);
  });
});
