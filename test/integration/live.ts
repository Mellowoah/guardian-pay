/**
 * Live integration test against a deployed Guardian Pay + the PayPal SANDBOX.
 *   BASE_URL=https://guardian-pay.onrender.com PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run integration
 * Synthetic data only. Never prints credentials. Resets the demo clock offset to 0 when done.
 */
import { readFileSync } from 'node:fs';
import { accessToken, assertSandbox } from '../../src/paypal.js';

const BASE = (process.env.BASE_URL ?? 'https://guardian-pay.onrender.com').replace(/\/$/, '');
const PP = process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
assertSandbox(PP);
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) { console.error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET required (sandbox)'); process.exit(2); }

const rows: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { rows.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };

async function api(user: string, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-demo-user': user }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function pp(path: string) {
  const token = await accessToken({ base: PP, clientId: clientId!, clientSecret: clientSecret! });
  const r = await fetch(PP + path, { headers: { Authorization: 'Bearer ' + token } });
  return { status: r.status, json: (await r.json()) as any };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number, every = 3000): Promise<T | undefined> {
  const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return undefined; await sleep(every); }
}
const auditOf = async (caseId: string) => (await api('reviewer_demo', 'GET', `/api/cases/${caseId}/audit`)).json.entries as any[];

async function main() {
  // cold start (Render free tier sleeps)
  const up = await waitFor(async () => { try { const r = await fetch(BASE + '/health'); return r.ok ? true : undefined; } catch { return undefined; } }, 150_000, 5000);
  if (!check('service up (/health)', !!up, BASE)) return;
  const me = await api('reviewer_demo', 'GET', '/api/admin/clock');
  check('API + demo auth live', me.status === 200, `clock offset ${me.json.offset_days}`);
  await api('reviewer_demo', 'POST', '/api/admin/clock', { offset_days: 0 });

  const created = await api('provider_demo', 'POST', '/api/cases', { title: 'Integration test: kitchen repair (synthetic)',
    milestones: [{ title: 'Happy path', amount: '20.00' }, { title: 'Reject path', amount: '15.00' }, { title: 'Lifecycle path', amount: '10.00' }] });
  if (!check('provider creates case with 3 milestones', created.status === 201, `case ${created.json.id}`)) return;
  const caseId: string = created.json.id; const [A, B, C] = created.json.milestones.map((m: any) => m.id as string);

  // negatives that must hold before any money moves
  check('family cannot create a case (403)', (await api('family_demo', 'POST', '/api/cases', { title: 'x', milestones: [{ title: 'a', amount: '1.00' }] })).status === 403);
  check('amount must be > 0 (400)', (await api('provider_demo', 'POST', '/api/cases', { title: 'x', milestones: [{ title: 'a', amount: '0.00' }] })).status === 400);

  // fund all three with the sandbox card (authorize only; no capture)
  for (const [label, id] of [['A', A], ['B', B], ['C', C]] as const) {
    const o = await api('family_demo', 'POST', `/api/milestones/${id}/order`, { payment_source: 'card' });
    check(`order+authorize ${label} (intent=AUTHORIZE, card)`, o.status === 201 && o.json.milestone?.state === 'authorized', `order ${o.json.payment?.order_id} auth ${o.json.payment?.original_authorization_id}`);
  }
  const wallet = await api('family_demo', 'POST', `/api/milestones/${(await api('provider_demo', 'POST', '/api/cases', { title: 'wallet link check (synthetic)', milestones: [{ title: 'w', amount: '1.00' }] })).json.milestones[0].id}/order`, { payment_source: 'paypal' });
  check('wallet path returns a PayPal approve link', wallet.status === 201 && /paypal\.com/.test(wallet.json.approve_url ?? ''), String(wallet.json.approve_url ?? '').split('?')[0]);

  // proof for A is a SYNTHETIC image upload (starts the advisory AI check); B and C use a plain note
  const img = readFileSync(new URL('../fixtures/proofs/good_receipt_notice.png', import.meta.url));
  const up = await api('provider_demo', 'POST', `/api/milestones/${A}/proof`, { filename: 'good_receipt_notice.png', file_base64: img.toString('base64') });
  check('proof image upload -> proof_submitted, check started, sha256 stored', up.status === 200 && up.json.milestone?.state === 'proof_submitted' && /^[0-9a-f]{64}$/.test(up.json.proof?.sha256 ?? ''), `sha256 ${String(up.json.proof?.sha256).slice(0, 12)}…`);
  for (const id of [B, C]) await api('provider_demo', 'POST', `/api/milestones/${id}/proof`, { note: 'synthetic photos attached' });
  const ver = await waitFor(async () => { const v = await api('family_demo', 'GET', `/api/milestones/${A}/verification`); return v.json.status === 'completed' ? v : undefined; }, 90_000, 2000);
  const vj = ver?.json;
  check('AI proof check completed: 6 bilingual checks, advisory only', !!vj && vj.checks?.length === 6 && vj.checks.every((c: any) => c.reason_en && c.reason_es) && vj.advisory_only === true && vj.human_approval_required === true,
    `provider ${vj?.provider}, recommendation ${vj?.recommendation}, score ${vj?.score}`);
  check('AI check never auto-approves (milestone still proof_submitted)', (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json.milestones.find((m: any) => m.id === A)?.state === 'proof_submitted');

  // ---- negatives
  check('provider approving its own milestone -> 403', (await api('provider_demo', 'POST', `/api/milestones/${A}/approve`)).status === 403);
  check('approve before verify -> 409', (await api('family_demo', 'POST', `/api/milestones/${A}/approve`)).status === 409);
  check('reject without reason -> 400', (await api('family_demo', 'POST', `/api/milestones/${B}/reject`, {})).status === 400);

  // ---- happy path with double-click
  check('reviewer verifies proof', (await api('reviewer_demo', 'POST', `/api/milestones/${A}/verify`, {})).status === 200);
  const [a1, a2] = await Promise.all([api('family_demo', 'POST', `/api/milestones/${A}/approve`), api('family_demo', 'POST', `/api/milestones/${A}/approve`)]);
  const capA = a1.json.payment?.capture_id;
  check('double-click approve: both 200, same capture id', a1.status === 200 && a2.status === 200 && !!capA && capA === a2.json.payment?.capture_id, `capture ${capA}`);
  const caseState = (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json;
  const pA = caseState.milestones.find((m: any) => m.id === A);
  const ord = await pp(`/v2/checkout/orders/${pA.payment.order_id}`);
  const caps = ord.json.purchase_units?.[0]?.payments?.captures ?? [];
  check('PayPal shows exactly ONE capture for the order', caps.length === 1 && caps[0].id === capA && caps[0].status === 'COMPLETED', `order ${pA.payment.order_id}, captures=${caps.length}, ${caps[0]?.amount?.value} ${caps[0]?.amount?.currency_code}`);
  check('milestone A captured', pA.state === 'captured');
  const audA = await auditOf(caseId);
  const seqA = audA.filter(x => x.target_id === A && /^milestone\./.test(x.action) && x.action !== 'milestone.created').map(x => x.after.state);
  check('audit trail for A: one row per transition', JSON.stringify(seqA) === JSON.stringify(['authorized', 'proof_submitted', 'verified', 'captured']), seqA.join(' > '));
  check('human approval recorded before capture', audA.findIndex(x => x.action === 'approval.approve' && x.target_id === A) >= 0 &&
    audA.findIndex(x => x.action === 'approval.approve' && x.target_id === A) < audA.findIndex(x => x.action === 'milestone.captured' && x.target_id === A));
  check('approve is idempotent after capture', (await api('family_demo', 'POST', `/api/milestones/${A}/approve`)).json.idempotent === true);

  // ---- reject path (also double-click)
  const [b1, b2] = await Promise.all([api('family_demo', 'POST', `/api/milestones/${B}/reject`, { reason: 'work not finished (synthetic)' }), api('family_demo', 'POST', `/api/milestones/${B}/reject`, { reason: 'work not finished (synthetic)' })]);
  check('reject (double-click): both 200, milestone voided', b1.status === 200 && b2.status === 200 && b1.json.milestone?.state === 'voided', `auth ${b1.json.payment?.original_authorization_id}`);
  const authB = await pp(`/v2/payments/authorizations/${b1.json.payment?.original_authorization_id}`);
  check('PayPal authorization for B is VOIDED', authB.json.status === 'VOIDED', `status ${authB.json.status}`);
  check('voided milestone cannot be approved (409)', (await api('family_demo', 'POST', `/api/milestones/${B}/approve`)).status === 409);

  // ---- webhook reconciliation (real PayPal events)
  const confirmed = await waitFor(async () => {
    const au = await auditOf(caseId); const a = au.some(x => x.action === 'reconcile.confirmed' && x.target_type === 'payment' && /capture/.test(x.after.note ?? ''));
    const b = au.some(x => x.action === 'reconcile.confirmed' && /void/.test(x.after.note ?? '')); return a && b ? { a, b } : undefined;
  }, Number(process.env.WEBHOOK_WAIT_MS ?? 120_000));
  check('webhooks reconciled: capture COMPLETED + authorization VOIDED confirmed', !!confirmed);

  // ---- lifecycle with fake clock (scoped to this case)
  const run = async () => (await api('reviewer_demo', 'POST', '/api/admin/run-jobs', { case_id: caseId })).json.lifecycle;
  try {
    await api('reviewer_demo', 'POST', '/api/admin/clock', { offset_days: 26 });
    const l1 = await run();
    const au1 = await auditOf(caseId);
    check('day 26: expiry warning written', l1?.warned === 1 && au1.some(x => x.action === 'payment.expiry_warning' && x.target_id !== A), JSON.stringify(l1));
    check('day 26: reauthorize attempted, PayPal says TOO_SOON (real honor period) -> deferred', l1?.deferred === 1 && au1.some(x => x.action === 'payment.reauthorize_deferred'), `deferred=${l1?.deferred}`);
    await api('reviewer_demo', 'POST', '/api/admin/clock', { offset_days: 30 });
    const l2 = await run();
    const cs2 = (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json.milestones.find((m: any) => m.id === C);
    check('day 30: milestone C expired', l2?.expired === 1 && cs2.state === 'expired', `payment ${cs2.payment?.status}`);
    check('expired milestone cannot be approved (409)', (await api('family_demo', 'POST', `/api/milestones/${C}/approve`)).status === 409);
  } finally { await api('reviewer_demo', 'POST', '/api/admin/clock', { offset_days: 0 }); }
  check('demo clock reset to 0', (await api('reviewer_demo', 'GET', '/api/admin/clock')).json.offset_days === 0);
  console.log(`\nSandbox ids: case ${caseId}\n  A(happy) milestone ${A} order ${pA.payment.order_id} auth ${pA.payment.original_authorization_id} capture ${capA}\n  B(reject) milestone ${B} order ${b1.json.payment?.order_id} auth ${b1.json.payment?.original_authorization_id} (VOIDED)\n  C(lifecycle) milestone ${C}`);
}

try { await main(); } catch (e) { check('unexpected error', false, (e as Error).message); }
const failed = rows.filter(r => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
