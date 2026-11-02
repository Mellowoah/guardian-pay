/**
 * Live integration test against a deployed Guardian Pay + the PayPal SANDBOX.
 *   BASE_URL=https://guardian-pay.onrender.com PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run integration
 * Synthetic data only. Never prints credentials. Needs auth tokens (GP_TOKEN_<USER> or GP_TOKEN_SECRET/PAYPAL_CLIENT_SECRET the server derives from). Lifecycle checks run only if admin routes are enabled on the target.
 */
import { readFileSync } from 'node:fs';
import { accessToken, assertSandbox } from '../../src/paypal.js';
import { authConfigFromEnv, tokenFor } from '../../src/auth.js';

const BASE = (process.env.BASE_URL ?? 'https://guardian-pay.onrender.com').replace(/\/$/, '');
const PP = process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
assertSandbox(PP);
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) { console.error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET required (sandbox)'); process.exit(2); }

// Bearer tokens: GP_TOKEN_<USER> env if set, else derived from GP_TOKEN_SECRET / PAYPAL_CLIENT_SECRET exactly as the server does (never printed)
const authCfg = authConfigFromEnv(process.env);
const tokenOf = (u: string) => tokenFor(authCfg, u, 0);
const ADMIN_TOKEN = authCfg.adminToken;
const rows: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { rows.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };

async function raw(auth: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function api(user: string, method: string, path: string, body?: unknown) { return raw(tokenOf(user), method, path, body); }
const adminApi = (method: string, path: string, body?: unknown) => raw(ADMIN_TOKEN, method, path, body);
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
  const me = await api('reviewer_demo', 'GET', '/api/me');
  check('API + bearer-token auth live', me.status === 200 && me.json.role === 'reviewer', `role ${me.json.role}`);
  check('no token -> 401; x-demo-user header alone -> 401; wrong token -> 401',
    (await raw(null, 'GET', '/api/cases')).status === 401 && (await raw(null, 'GET', '/api/cases', undefined, { 'x-demo-user': 'family_demo' })).status === 401 && (await raw('gp_' + 'z'.repeat(43), 'GET', '/api/cases')).status === 401);
  check('debug webhook listing is not public', [401, 404].includes((await raw(null, 'GET', '/api/debug/webhooks')).status));
  const adminProbe = await adminApi('GET', '/api/admin/cases/123e4567-e89b-12d3-a456-426614174000/clock');
  const adminOn = adminProbe.status !== 404; // 404 = admin routes disabled (the default and the production setting)
  check(adminOn ? 'admin routes enabled for this run (admin token accepted)' : 'admin routes are OFF by default (404 even with the admin token)', adminOn ? adminProbe.status !== 401 : true, `status ${adminProbe.status}`);
  check('a reviewer token never opens the admin surface', [401, 404].includes((await api('reviewer_demo', 'POST', '/api/admin/run-jobs', {})).status));

  const created = await api('provider_demo', 'POST', '/api/cases', { title: 'Integration test: kitchen repair (synthetic)', beneficiary_name: 'Mateo Reyes', case_type: 'Family petition (synthetic)',
    milestones: [{ title: 'Happy path', amount: '20.00', form_type: 'I-130', document_type: 'receipt_notice' }, { title: 'Reject path', amount: '15.00' }, { title: 'Lifecycle path', amount: '10.00' }, { title: 'Reuse path', amount: '5.00', form_type: 'I-130', document_type: 'receipt_notice' }] });
  if (!check('provider creates case with 4 milestones', created.status === 201, `case ${created.json.id}`)) return;
  const caseId: string = created.json.id; const [A, B, C, D] = created.json.milestones.map((m: any) => m.id as string);

  // negatives that must hold before any money moves
  check('reviewer cannot fund (403); provider cannot fund (403)', (await api('reviewer_demo', 'POST', `/api/milestones/${A}/order`, { payment_source: 'card' })).status === 403 && (await api('provider_demo', 'POST', `/api/milestones/${A}/order`, { payment_source: 'card' })).status === 403);
  check('family cannot create a case (403)', (await api('family_demo', 'POST', '/api/cases', { title: 'x', milestones: [{ title: 'a', amount: '1.00' }] })).status === 403);
  check('amount must be > 0 (400)', (await api('provider_demo', 'POST', '/api/cases', { title: 'x', milestones: [{ title: 'a', amount: '0.00' }] })).status === 400);

  // fund all three with the sandbox card (authorize only; no capture)
  for (const [label, id] of [['A', A], ['B', B], ['C', C], ['D', D]] as const) {
    const o = await api('family_demo', 'POST', `/api/milestones/${id}/order`, { payment_source: 'card' });
    check(`order+authorize ${label} (intent=AUTHORIZE, card)`, o.status === 201 && o.json.milestone?.state === 'authorized', `order ${o.json.payment?.order_id} auth ${o.json.payment?.original_authorization_id}`);
  }
  const wallet = await api('family_demo', 'POST', `/api/milestones/${(await api('provider_demo', 'POST', '/api/cases', { title: 'wallet link check (synthetic)', milestones: [{ title: 'w', amount: '1.00' }] })).json.milestones[0].id}/order`, { payment_source: 'paypal' });
  check('wallet path returns a PayPal approve link', wallet.status === 201 && /paypal\.com/.test(wallet.json.approve_url ?? ''), String(wallet.json.approve_url ?? '').split('?')[0]);

  // proof for A is a SYNTHETIC image upload (starts the advisory AI check); B and C use a plain note
  const img = readFileSync(new URL('../fixtures/proofs/good_receipt_notice.png', import.meta.url));
  const upl = await api('provider_demo', 'POST', `/api/milestones/${A}/proof`, { filename: 'good_receipt_notice.png', file_base64: img.toString('base64') });
  check('proof image upload -> proof_submitted, check started, sha256 stored', upl.status === 200 && upl.json.milestone?.state === 'proof_submitted' && /^[0-9a-f]{64}$/.test(upl.json.proof?.sha256 ?? ''), `sha256 ${String(upl.json.proof?.sha256).slice(0, 12)}…`);
  for (const id of [B, C]) await api('provider_demo', 'POST', `/api/milestones/${id}/proof`, { note: 'synthetic photos attached' });
  const ver = await waitFor(async () => { const v = await api('family_demo', 'GET', `/api/milestones/${A}/verification`); return v.json.status === 'completed' ? v : undefined; }, 90_000, 2000);
  const vj = ver?.json;
  check('AI proof check completed: 7 bilingual checks, advisory only', !!vj && vj.checks?.length === 7 && vj.checks.every((c: any) => c.reason_en && c.reason_es) && vj.advisory_only === true && vj.human_approval_required === true,
    `provider ${vj?.provider}, recommendation ${vj?.recommendation}, score ${vj?.score}`);
  if (vj && !String(vj.provider).startsWith('none')) {
    const st = Object.fromEntries((vj.checks ?? []).map((c: any) => [c.id, c.status]));
    check('real AI extraction worked on live (not all not_run, no error, fields read)', !vj.error && !!vj.extraction?.receipt_number && vj.checks.some((c: any) => c.status !== 'not_run') && st.receipt_format === 'pass' && st.form_type_match === 'pass' && st.beneficiary_match === 'pass' && st.document_type_match === 'pass',
      `attempts ${vj.attempts}, error ${String(vj.error).slice(0, 80)}, ${Object.entries(st).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  check('AI check never auto-approves (milestone still proof_submitted)', (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json.milestones.find((m: any) => m.id === A)?.state === 'proof_submitted');

  const prf = await api('family_demo', 'GET', `/api/milestones/${A}/proof`);
  const body = { proof_sha256: prf.json.sha256, proof_id: prf.json.proof_id };
  check('family can read the proof it must approve (sha256 + id) and fetch the image; provider cannot', prf.status === 200 && /^[0-9a-f]{64}$/.test(prf.json.sha256 ?? '') && (await api('provider_demo', 'GET', `/api/milestones/${A}/proof/image`)).status === 403 && (await api('family_demo', 'GET', `/api/milestones/${A}/proof/image`)).status === 200);
  check('proof_not_reused passes on first use', vj?.checks?.find((c: any) => c.id === 'proof_not_reused')?.status === 'pass');

  // ---- negatives
  check('provider approving its own milestone -> 403', (await api('provider_demo', 'POST', `/api/milestones/${A}/approve`, body)).status === 403);
  check('reviewer cannot approve (verifies only) -> 403', (await api('reviewer_demo', 'POST', `/api/milestones/${A}/approve`, body)).status === 403);
  check('family cannot verify -> 403', (await api('family_demo', 'POST', `/api/milestones/${A}/verify`, {})).status === 403);
  check('approve before verify -> 409', (await api('family_demo', 'POST', `/api/milestones/${A}/approve`, body)).status === 409);
  check('proof reuse: same image on a second milestone -> proof_not_reused FAIL, human review, never approve', await (async () => {
    await api('provider_demo', 'POST', `/api/milestones/${D}/proof`, { filename: 'good_receipt_notice.png', file_base64: img.toString('base64') });
    const v = await waitFor(async () => { const r = await api('family_demo', 'GET', `/api/milestones/${D}/verification`); return r.json.status === 'completed' ? r : undefined; }, 90_000, 2000);
    const c = v?.json.checks?.find((x: any) => x.id === 'proof_not_reused'); return c?.status === 'fail' && v?.json.recommendation === 'needs_human_review';
  })());
  check('reject without reason -> 400', (await api('family_demo', 'POST', `/api/milestones/${B}/reject`, {})).status === 400);

  // ---- happy path with double-click
  check('reviewer verifies proof', (await api('reviewer_demo', 'POST', `/api/milestones/${A}/verify`, {})).status === 200);
  check('approve without naming the proof -> 400; a wrong/stale proof hash -> 409', (await api('family_demo', 'POST', `/api/milestones/${A}/approve`, {})).status === 400 && (await api('family_demo', 'POST', `/api/milestones/${A}/approve`, { proof_sha256: 'f'.repeat(64) })).status === 409);
  const [a1, a2] = await Promise.all([api('family_demo', 'POST', `/api/milestones/${A}/approve`, body), api('family_demo', 'POST', `/api/milestones/${A}/approve`, body)]);
  const capA = a1.json.payment?.capture_id;
  check('double-click approve: both 200, same capture id', a1.status === 200 && a2.status === 200 && !!capA && capA === a2.json.payment?.capture_id, `capture ${capA}`);
  const caseState = (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json;
  const pA = caseState.milestones.find((m: any) => m.id === A);
  const ord = await pp(`/v2/checkout/orders/${pA.payment.order_id}`);
  const caps = ord.json.purchase_units?.[0]?.payments?.captures ?? [];
  check('PayPal shows exactly ONE capture for the order', caps.length === 1 && caps[0].id === capA && caps[0].status === 'COMPLETED', `order ${pA.payment.order_id}, captures=${caps.length}, ${caps[0]?.amount?.value} ${caps[0]?.amount?.currency_code}`);
  check('milestone A captured; verified_by reviewer_demo, approved_by family_demo (separation of duties)', pA.state === 'captured' && pA.verified_by === 'reviewer_demo' && pA.approved_by === 'family_demo');
  const audA = await auditOf(caseId);
  const seqA = audA.filter(x => x.target_id === A && /^milestone\./.test(x.action) && x.action !== 'milestone.created').map(x => x.after.state);
  check('audit trail for A: one row per transition', JSON.stringify(seqA) === JSON.stringify(['authorized', 'proof_submitted', 'verified', 'captured']), seqA.join(' > '));
  check('human approval recorded before capture', audA.findIndex(x => x.action === 'approval.approve' && x.target_id === A) >= 0 &&
    audA.findIndex(x => x.action === 'approval.approve' && x.target_id === A) < audA.findIndex(x => x.action === 'milestone.captured' && x.target_id === A));
  check('approve is idempotent after capture', (await api('family_demo', 'POST', `/api/milestones/${A}/approve`, body)).json.idempotent === true);

  // ---- reject path (also double-click)
  const [b1, b2] = await Promise.all([api('family_demo', 'POST', `/api/milestones/${B}/reject`, { reason: 'work not finished (synthetic)' }), api('family_demo', 'POST', `/api/milestones/${B}/reject`, { reason: 'work not finished (synthetic)' })]);
  check('reject (double-click): both 200, milestone voided', b1.status === 200 && b2.status === 200 && b1.json.milestone?.state === 'voided', `auth ${b1.json.payment?.original_authorization_id}`);
  const authB = await pp(`/v2/payments/authorizations/${b1.json.payment?.original_authorization_id}`);
  check('PayPal authorization for B is VOIDED', authB.json.status === 'VOIDED', `status ${authB.json.status}`);
  check('voided milestone cannot be approved (409)', (await api('family_demo', 'POST', `/api/milestones/${B}/approve`, body)).status === 409);

  // ---- webhook reconciliation (real PayPal events)
  const confirmed = await waitFor(async () => {
    const au = await auditOf(caseId); const a = au.some(x => x.action === 'reconcile.confirmed' && x.target_type === 'payment' && /capture/.test(x.after.note ?? ''));
    const b = au.some(x => x.action === 'reconcile.confirmed' && /void/.test(x.after.note ?? '')); return a && b ? { a, b } : undefined;
  }, Number(process.env.WEBHOOK_WAIT_MS ?? 120_000));
  check('webhooks reconciled: capture COMPLETED + authorization VOIDED confirmed', !!confirmed);

  // ---- family may reject even AFTER the reviewer verified (milestone D)
  check('family can reject after verification (reviewer verified, family says no) -> voided', await (async () => {
    await api('reviewer_demo', 'POST', `/api/milestones/${D}/verify`, {});
    const r = await api('family_demo', 'POST', `/api/milestones/${D}/reject`, { reason: 'changed our mind after review (synthetic)' });
    return r.status === 200 && r.json.milestone?.state === 'voided';
  })());

  // ---- lifecycle with the per-case demo clock (only when the admin surface is enabled)
  if (!adminOn) {
    check('lifecycle/clock checks skipped on this target: admin routes disabled (as designed); covered by the local run with ENABLE_ADMIN_ROUTES=true', true);
  } else {
    const run = async () => (await adminApi('POST', '/api/admin/run-jobs', { case_id: caseId })).json.lifecycle;
    const setClock = (d: number) => adminApi('POST', `/api/admin/cases/${caseId}/clock`, { offset_days: d, reason: 'integration test' });
    try {
      check('clock above 60 days or negative is refused (400)', (await setClock(61)).status === 400 && (await setClock(-1)).status === 400);
      check('set per-case clock to day 26', (await setClock(26)).status === 200);
      const l1 = await run();
      const au1 = await auditOf(caseId);
      check('day 26: expiry warning written', l1?.warned >= 1 && au1.some(x => x.action === 'payment.expiry_warning' && x.target_id !== A), JSON.stringify(l1));
      check('day 26: reauthorize attempted, PayPal says TOO_SOON (real honor period) -> deferred', l1?.deferred >= 1 && au1.some(x => x.action === 'payment.reauthorize_deferred'), `deferred=${l1?.deferred}`);
      check('clock change is audited', au1.some(x => x.action === 'admin.clock_set' && x.after.offset_days === 26));
      await setClock(30);
      const l2 = await run();
      const cs2 = (await api('reviewer_demo', 'GET', `/api/cases/${caseId}`)).json.milestones.find((m: any) => m.id === C);
      check('day 30: demo clock alone does NOT expire money (PayPal still says CREATED): expire_blocked, state unchanged', l2?.expired === 0 && l2?.expire_blocked >= 1 && cs2.state === 'authorized' && (await auditOf(caseId)).some(x => x.action === 'payment.expire_blocked'), JSON.stringify(l2));
      check('milestone C still cannot be approved before verification (409)', (await api('family_demo', 'POST', `/api/milestones/${C}/approve`, body)).status === 409);
    } finally { await setClock(0); }
    check('demo clock reset to 0', (await adminApi('GET', `/api/admin/cases/${caseId}/clock`)).json.offset_days === 0);
  }
  console.log(`\nSandbox ids: case ${caseId}\n  A(happy) milestone ${A} order ${pA.payment.order_id} auth ${pA.payment.original_authorization_id} capture ${capA}\n  B(reject) milestone ${B} order ${b1.json.payment?.order_id} auth ${b1.json.payment?.original_authorization_id} (VOIDED)\n  C(lifecycle) milestone ${C}`);
}

try { await main(); } catch (e) { check('unexpected error', false, (e as Error).message); }
const failed = rows.filter(r => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
