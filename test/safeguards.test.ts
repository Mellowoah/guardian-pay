import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { TEST_URL, TEST_AUTH, tok, ADMIN, setup, newCase, fundedMilestone, toVerified, approveCur, setClock, type Env } from './helpers.js';
import { HttpError } from '../src/repo.js';
import { GuardDenied } from '../src/guard.js';
import { fixtureExtractor, makeExtractor, FixtureInProduction } from '../src/verify/extraction.js';
import { authConfigFromEnv, deriveToken, tokenFor, adminAuth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { buildApi, buildAdminApi } from '../src/routes.js';

const opts = { skip: TEST_URL ? false : 'DATABASE_URL_TEST not set' };
const code = async (p: Promise<unknown>) => { try { await p; return 'no-error'; } catch (e) { return e instanceof HttpError ? `${e.status}:${e.code}` : e instanceof GuardDenied ? 'guard_denied' : `x:${(e as Error).message}`; } };
const fx = (n: string) => readFileSync(new URL(`./fixtures/proofs/${n}.png`, import.meta.url));
const audit = async (e: Env, caseId: string) => (await e.db.query('SELECT actor, action, before, after FROM audit_log WHERE case_id = $1 ORDER BY id', [caseId])).rows;
const pay = async (e: Env, id: string) => (await e.db.query('SELECT * FROM payments WHERE milestone_id = $1', [id])).rows[0];
const state = async (e: Env, id: string) => (await e.db.query('SELECT state FROM milestones WHERE id = $1', [id])).rows[0].state;

describe('separation of duties + approval bound to the proof', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { await e.close(); });

  test('reviewer verifies, FAMILY approves: reviewer/provider cannot approve or fund; verified_by and approved_by are recorded and differ', async () => {
    const f = await toVerified(e);
    assert.equal(await code(approveCur(e, f.id, e.reviewer)), '403:forbidden');
    assert.equal(await code(approveCur(e, f.id, e.provider)), '403:forbidden');
    assert.equal(await code(e.svc.openOrder(e.reviewer, (await newCase(e)).milestones[0].id, { payment_source: 'card' })), '403:forbidden');
    assert.equal(e.fake.captureCalls.length, 0);
    const r = await approveCur(e, f.id);
    assert.equal(r.milestone.state, 'captured'); assert.equal(r.milestone.verified_by, 'reviewer_demo'); assert.equal(r.milestone.approved_by, 'family_demo');
    const m = (await e.db.query('SELECT verified_by, approved_by, verified_proof_sha256 FROM milestones WHERE id = $1', [f.id])).rows[0];
    assert.notEqual(m.verified_by, m.approved_by); assert.ok(m.verified_proof_sha256);
    const row = (await audit(e, f.caseId)).find(x => x.action === 'approval.approve')!;
    assert.deepEqual([row.after.approved_by, row.after.verified_by], ['family_demo', 'reviewer_demo']);
  });

  test('approving requires naming the proof you saw; a different or stale proof is refused and nothing is captured', async () => {
    const f = await toVerified(e); const caps0 = e.fake.captureCalls.length;
    assert.equal(await code(e.svc.approve(e.family, f.id, {})), '400:bad_request');
    assert.equal(await code(e.svc.approve(e.family, f.id, { proof_sha256: 'e'.repeat(64) })), '409:stale_proof');
    assert.equal(await code(approveCur(e, f.id, e.family, { proof_id: '123e4567-e89b-12d3-a456-426614174000' })), '409:stale_proof');
    assert.equal(e.fake.captureCalls.length, caps0);
  });

  test('guard re-checks the binding itself: if the proof on file changes after approval, capture is denied (PayPal never called)', async () => {
    const f = await toVerified(e);
    const proof = (await e.db.query('SELECT id, sha256 FROM proofs WHERE milestone_id = $1', [f.id])).rows[0];
    await e.db.query(`INSERT INTO approvals (milestone_id, user_id, decision, proof_id, proof_sha256) VALUES ($1,$2,'approve',$3,$4)`, [f.id, e.family.userId, proof.id, proof.sha256]);
    await e.db.query(`INSERT INTO proofs (milestone_id, uploaded_by, content_type, size_bytes, sha256) VALUES ($1,$2,'text/plain',1,$3)`, [f.id, e.provider.userId, 'd'.repeat(64)]); // swapped proof
    const authId = (await pay(e, f.id)).current_authorization_id; const caps = e.fake.captureCalls.length;
    await assert.rejects(e.guarded.capture({ actor: e.family, milestone: { id: f.id, state: 'verified', providerUserId: e.provider.userId! }, amount: '25.00', attempt: 1 }, authId, 'USD'), (x: any) => x instanceof GuardDenied && /proof changed/.test(x.reason));
    assert.equal(e.fake.captureCalls.length, caps);
  });

  test('guard denies capture when the verifier IS the approver (tampered in SQL), and when verified_by is missing', async () => {
    const f = await toVerified(e); const caps0 = e.fake.captureCalls.length; const proof = (await e.db.query('SELECT id, sha256 FROM proofs WHERE milestone_id = $1', [f.id])).rows[0];
    await e.db.query(`INSERT INTO approvals (milestone_id, user_id, decision, proof_id, proof_sha256) VALUES ($1,$2,'approve',$3,$4)`, [f.id, e.family.userId, proof.id, proof.sha256]);
    const ctx = { actor: e.family, milestone: { id: f.id, state: 'verified' as const, providerUserId: e.provider.userId! }, amount: '25.00', attempt: 1 };
    const authId = (await pay(e, f.id)).current_authorization_id;
    await e.db.query('UPDATE milestones SET verified_by = $2 WHERE id = $1', [f.id, e.family.userId]);
    await assert.rejects(e.guarded.capture(ctx, authId, 'USD'), /different people/);
    await e.db.query('UPDATE milestones SET verified_by = NULL WHERE id = $1', [f.id]);
    await assert.rejects(e.guarded.capture(ctx, authId, 'USD'), /verified_by missing/);
    assert.equal(e.fake.captureCalls.length, caps0);
  });

  test('the family can reject/dispute AFTER the reviewer verified: verified -> rejected -> voided, authorization voided; reviewer cannot', async () => {
    const f = await toVerified(e);
    assert.equal(await code(e.svc.reject(e.reviewer, f.id, { reason: 'x' })), '409:conflict'); // a reviewer can only reject unverified proof
    const r = await e.svc.reject(e.family, f.id, { reason: 'on reflection the work is not what we agreed (synthetic)' });
    assert.equal(r.milestone.state, 'voided');
    const rows = await audit(e, f.caseId);
    assert.ok(rows.some(x => x.action === 'approval.reject' && x.after.after_verification === true));
    assert.deepEqual(rows.filter(x => x.action === 'milestone.rejected' || x.action === 'milestone.voided').map(x => x.action), ['milestone.rejected', 'milestone.voided']);
    assert.equal(e.fake.auths.get((await pay(e, f.id)).original_authorization_id)!.status, 'VOIDED');
    assert.equal(await code(approveCur(e, f.id)), '409:conflict');
  });

  test('only the CASE family acts; a reviewer may still reject unverified proof', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { note: 'x' });
    const other = { ...e.family, userId: e.family.userId! + 1000 };
    assert.equal(await code(e.svc.reject(other, f.id, { reason: 'x' })), '403:forbidden');
    assert.equal((await e.svc.reject(e.reviewer, f.id, { reason: 'proof is clearly wrong (synthetic)' })).milestone.state, 'voided');
  });
});

describe('proof reuse registry (cross-case)', opts, () => {
  let e: Env; before(async () => { e = await setup(fixtureExtractor); }); after(async () => { await e.close(); });
  const mk = async () => {
    const c = await e.svc.createCase(e.provider, { title: 'Reuse test (synthetic)', beneficiary_name: 'Mateo Reyes', milestones: [{ title: 'M1', amount: '25.00', form_type: 'I-130', document_type: 'receipt_notice' }] });
    await e.db.query(`UPDATE cases SET created_at = '2026-01-15T00:00:00Z' WHERE id = $1`, [c.id]);
    await e.svc.openOrder(e.family, c.milestones[0].id, { payment_source: 'card' }); return { caseId: c.id, id: c.milestones[0].id };
  };
  const up = (id: string, name = 'good_receipt_notice') => e.svc.submitProof(e.provider, id, { file_base64: fx(name).toString('base64'), filename: name + '.png' });

  test('same image on a second case fails proof_not_reused, goes to human review with the reason shown, no ids leaked; first use passes', async () => {
    const a = await mk(); await up(a.id); await e.verifier!.idle();
    const va = await e.svc.verification(e.family, a.id);
    assert.equal(va.recommendation, 'recommend_approve'); assert.equal(va.checks.find((c: any) => c.id === 'proof_not_reused').status, 'pass');
    const b = await mk(); await up(b.id); await e.verifier!.idle();
    const vb = await e.svc.verification(e.family, b.id);
    const chk = vb.checks.find((c: any) => c.id === 'proof_not_reused');
    assert.equal(chk.status, 'fail'); assert.match(chk.reason_en, /already submitted/); assert.ok(chk.reason_es);
    assert.equal(vb.recommendation, 'needs_human_review'); assert.ok(vb.explanation.highlighted.includes('proof_not_reused'));
    assert.ok(!JSON.stringify(vb.checks).includes(a.caseId) && !JSON.stringify(vb.checks).includes(a.id));
    assert.equal(await state(e, b.id), 'proof_submitted'); // advisory only
    const done = (await audit(e, b.caseId)).find(x => x.action === 'verification.completed')!; assert.equal(done.after.reuse.same_image, 1);
  });
  test('a different image with the same receipt number is also caught', async () => {
    const a = await mk(); await up(a.id, 'good_rfe_response'); await e.verifier!.idle(); // SRC2698765432
    const b = await mk(); await up(b.id, 'good_rfe_response'); await e.verifier!.idle();
    assert.equal((await e.svc.verification(e.family, b.id)).checks.find((c: any) => c.id === 'proof_not_reused').status, 'fail');
    // simulate a re-encoded copy: same receipt number registered under a different hash
    await e.db.query(`UPDATE proof_registry SET sha256 = 'z' || substr(sha256, 2) WHERE milestone_id = $1`, [b.id]);
    const c = await mk(); await up(c.id, 'good_rfe_response'); await e.verifier!.idle();
    assert.equal((await e.svc.verification(e.family, c.id)).checks.find((k: any) => k.id === 'proof_not_reused').status, 'fail');
  });
});

describe('proof image endpoint + proof metadata', opts, () => {
  let e: Env; before(async () => { e = await setup(fixtureExtractor); }); after(async () => { await e.close(); });
  test('family and reviewer can fetch the image; provider/other roles cannot; unknown/note-only 404; bytes gone after the decision (410)', async () => {
    const c = await e.svc.createCase(e.provider, { title: 'img (synthetic)', milestones: [{ title: 'M', amount: '10.00' }] }); const id = c.milestones[0].id;
    await e.svc.openOrder(e.family, id, { payment_source: 'card' });
    assert.equal(await code(e.svc.proofImage(e.family, id)), '404:not_found');
    await e.svc.submitProof(e.provider, id, { file_base64: fx('good_receipt_notice').toString('base64') });
    const img = await e.svc.proofImage(e.family, id); assert.equal(img.mime, 'image/png'); assert.ok(img.bytes.equals(fx('good_receipt_notice')));
    assert.equal((await e.svc.proofImage(e.reviewer, id)).sha256, img.sha256);
    assert.equal(await code(e.svc.proofImage(e.provider, id)), '403:forbidden');
    assert.equal(await code(e.svc.proofImage({ ...e.family, userId: e.family.userId! + 1000 }, id)), '403:forbidden');
    await e.verifier!.idle(); await e.svc.verifyProof(e.reviewer, id, {}); await approveCur(e, id);
    assert.equal(await code(e.svc.proofImage(e.family, id)), '410:gone');
  });
  test('HTTP: headers are inert, auth is enforced', async () => {
    const f = await fundedMilestone(e); await e.svc.submitProof(e.provider, f.id, { file_base64: fx('forged_subtle').toString('base64') });
    const srv = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, TEST_AUTH) }).listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/api/milestones/${f.id}/proof/image`)).status, 401);
      assert.equal((await fetch(`${base}/api/milestones/${f.id}/proof/image`, { headers: { authorization: tok('provider_demo') } })).status, 403);
      const r = await fetch(`${base}/api/milestones/${f.id}/proof/image`, { headers: { authorization: tok('family_demo') } });
      assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/); assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      assert.equal(Buffer.from(await r.arrayBuffer()).length, fx('forged_subtle').length);
    } finally { srv.close(); }
  });
});

describe('auth tokens and role checks', opts, () => {
  let e: Env; let srv: ReturnType<ReturnType<typeof createApp>['listen']>; let base = '';
  before(async () => { e = await setup(); srv = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, TEST_AUTH) }).listen(0); base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; });
  after(async () => { srv.close(); await e.close(); });
  const get = (path: string, auth?: string) => fetch(base + path, { headers: auth ? { authorization: auth } : {} });

  test('unique 256-bit token per user; wrong/other-secret/malformed/header-spoof tokens are all 401; /me returns the right actor', async () => {
    const ts = ['family_demo', 'provider_demo', 'provider_two', 'reviewer_demo'].map(u => tokenFor(TEST_AUTH, u)!);
    assert.equal(new Set(ts).size, 4); for (const t of ts) assert.match(t, /^gp_[A-Za-z0-9_-]{43}$/);
    const me = await (await get('/api/me', tok('family_demo'))).json() as any; assert.equal(me.label, 'family_demo'); assert.equal(me.role, 'family');
    assert.equal((await get('/api/me')).status, 401);
    assert.equal((await get('/api/me', 'Bearer ' + deriveToken('some-other-secret-0123456789', 'family_demo'))).status, 401);
    assert.equal((await get('/api/me', 'Bearer short')).status, 401);
    assert.equal((await get('/api/me', 'Basic ' + ts[0])).status, 401);
    assert.equal((await fetch(base + '/api/me', { headers: { 'x-demo-user': 'reviewer_demo', authorization: tok('family_demo') } }).then(r => r.json()) as any).role, 'family'); // header is ignored
  });
  test('env-provided per-user tokens override derived ones; short env tokens are ignored; epoch bump revokes a derived token', async () => {
    const long = 'gp_' + 'q'.repeat(40);
    const cfg = authConfigFromEnv({ GP_TOKEN_SECRET: 'test-secret-0123456789abcdef', GP_TOKEN_FAMILY_DEMO: long, GP_TOKEN_PROVIDER_DEMO: 'tooshort' });
    assert.equal(tokenFor(cfg, 'family_demo'), long); assert.equal(tokenFor(cfg, 'provider_demo'), deriveToken('test-secret-0123456789abcdef', 'provider_demo'));
    const s2 = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, cfg) }).listen(0); const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(b2 + '/api/me', { headers: { authorization: 'Bearer ' + long } })).status, 200);
      assert.equal((await fetch(b2 + '/api/me', { headers: { authorization: tok('family_demo') } })).status, 401); // derived token no longer accepted for that user
    } finally { s2.close(); }
    assert.equal(authConfigFromEnv({}).key, null); assert.equal(tokenFor(authConfigFromEnv({}), 'family_demo'), null);
    await e.svc.revokeUserToken(ADMIN, 'provider_two');
    assert.equal((await get('/api/me', tok('provider_two'))).status, 401);
    assert.equal((await get('/api/me', 'Bearer ' + deriveToken('test-secret-0123456789abcdef', 'provider_two', 1))).status, 200);
  });
  test('every route is role-checked: wrong role gets 403 (never reaches the service), no token gets 401', async () => {
    const call = async (u: string | null, m: string, p: string, b: unknown = {}) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(u ? { authorization: tok(u) } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b) })).status;
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const table: [string, string, string, string[]][] = [ // method, path, allowed roles, forbidden users
      ['POST', '/api/cases', 'provider', ['family_demo', 'reviewer_demo']],
      ['POST', `/api/milestones/${id}/order`, 'family', ['provider_demo', 'reviewer_demo']],
      ['POST', `/api/milestones/${id}/authorize`, 'family', ['provider_demo', 'reviewer_demo']],
      ['POST', `/api/milestones/${id}/proof`, 'provider', ['family_demo', 'reviewer_demo']],
      ['POST', `/api/milestones/${id}/verify`, 'reviewer', ['family_demo', 'provider_demo']],
      ['POST', `/api/milestones/${id}/approve`, 'family', ['provider_demo', 'reviewer_demo']],
      ['POST', `/api/milestones/${id}/reject`, 'family|reviewer', ['provider_demo']],
      ['GET', `/api/milestones/${id}/proof/image`, 'family|reviewer', ['provider_demo']],
    ];
    for (const [m, p, , bad] of table) { assert.equal(await call(null, m, p), 401, `${m} ${p} unauthenticated`); for (const u of bad) assert.equal(await call(u, m, p), 403, `${m} ${p} as ${u}`); }
  });
});

describe('admin routes: off by default, admin token, per-case audited clock', opts, () => {
  let e: Env; before(async () => { e = await setup(); }); after(async () => { await e.close(); });
  const serveWith = (enable: boolean) => {
    const cfg = authConfigFromEnv({ GP_TOKEN_SECRET: 'test-secret-0123456789abcdef', ENABLE_ADMIN_ROUTES: String(enable) });
    const admin = enable ? { gate: adminAuth(cfg), router: buildAdminApi(e.db, e.svc, e.guarded, cfg) } : undefined;
    const srv = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, cfg), admin }).listen(0);
    return { cfg, srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
  };
  test('disabled by default: admin and debug routes are not mounted (404/401 even with a valid user token)', async () => {
    const { srv, base } = serveWith(false);
    try {
      for (const p of ['/api/admin/run-jobs', '/api/admin/cases/123e4567-e89b-12d3-a456-426614174000/clock', '/api/debug/webhooks']) {
        const r = await fetch(base + p, { method: p.includes('run-jobs') ? 'POST' : 'GET', headers: { authorization: tok('reviewer_demo'), 'content-type': 'application/json' }, body: p.includes('run-jobs') ? '{}' : undefined });
        assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
      }
    } finally { srv.close(); }
  });
  test('enabled: needs the admin token (a reviewer token is not enough); clock is per case, 0-60, audited, and affects only that case', async () => {
    const { cfg, srv, base } = serveWith(true); const admin = 'Bearer ' + cfg.adminToken;
    try {
      const f1 = await fundedMilestone(e); const f2 = await fundedMilestone(e);
      const post = (path: string, auth: string | null, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
      assert.equal((await post(`/api/admin/cases/${f1.caseId}/clock`, null, { offset_days: 5 })).status, 401);
      assert.equal((await post(`/api/admin/cases/${f1.caseId}/clock`, tok('reviewer_demo'), { offset_days: 5 })).status, 401);
      assert.equal((await post(`/api/admin/cases/${f1.caseId}/clock`, admin, { offset_days: 61 })).status, 400);
      assert.equal((await post(`/api/admin/cases/${f1.caseId}/clock`, admin, { offset_days: -1 })).status, 400);
      assert.equal((await post(`/api/admin/cases/${f1.caseId}/clock`, admin, { offset_days: 26, reason: 'demo day 26' })).status, 200);
      const g = await (await fetch(`${base}/api/admin/cases/${f1.caseId}/clock`, { headers: { authorization: admin } })).json() as any; assert.equal(g.offset_days, 26);
      assert.equal((await e.svc.getCaseClock(f2.caseId)).offset_days, 0); // other case untouched
      const a1 = (await audit(e, f1.caseId)).find(x => x.action === 'admin.clock_set')!; assert.deepEqual([a1.before.offset_days, a1.after.offset_days, a1.after.reason], [0, 26, 'demo day 26']);
      assert.equal((await audit(e, f2.caseId)).filter(x => x.action === 'admin.clock_set').length, 0);
      // run-jobs on case 2 does nothing to case 1; on case 1 it warns but never expires (PayPal says CREATED)
      const r2 = await (await post('/api/admin/run-jobs', admin, { case_id: f2.caseId })).json() as any; assert.equal(r2.lifecycle.warned, 0);
      await setClock(e, f1.caseId, 30);
      const r1 = await (await post('/api/admin/run-jobs', admin, { case_id: f1.caseId })).json() as any; assert.equal(r1.lifecycle.expired, 0); assert.equal(r1.lifecycle.expire_blocked, 1);
      assert.equal(await state(e, f1.id), 'authorized'); assert.equal(await state(e, f2.id), 'authorized');
      assert.equal((await fetch(base + '/api/debug/webhooks', { headers: { authorization: tok('reviewer_demo') } })).status, 401);
      assert.equal((await fetch(base + '/api/debug/webhooks', { headers: { authorization: admin } })).status, 200);
    } finally { srv.close(); }
  });
  test('setCaseClock is admin-only at the service layer too', async () => {
    const f = await fundedMilestone(e);
    assert.equal(await code(e.svc.setCaseClock(e.reviewer, f.caseId, 5, 'x')), '403:forbidden');
    assert.equal(await code(e.svc.setCaseClock(ADMIN, f.caseId, 3.5, 'x')), '400:bad_request');
  });
});

test('fixture extractor refuses to start in production or on Render (and logs loudly)', () => {
  assert.throws(() => makeExtractor({ AI_PROVIDER: 'fixture', NODE_ENV: 'production' }), FixtureInProduction);
  assert.throws(() => makeExtractor({ AI_PROVIDER: 'fixture', RENDER: 'true' }), /REFUSING TO START/);
  assert.throws(() => makeExtractor({ AI_PROVIDER: 'fixture', RENDER_SERVICE_ID: 'srv-x' }), FixtureInProduction);
  assert.equal(makeExtractor({ AI_PROVIDER: 'fixture' }).name, 'fixture'); // dev/test still fine
  assert.equal(makeExtractor({ AI_PROVIDER: 'fixture', NODE_ENV: 'test' }).name, 'fixture');
  assert.equal(makeExtractor({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', NODE_ENV: 'production' }).name.startsWith('gemini'), true);
});
