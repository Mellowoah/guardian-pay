import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { matchNames, nameTokens, placeHasState, stateName } from '../src/payee/names.js';
import { PractitionerRegistry, SimulatedBar, isReinstated, type Snapshot, type RepRecord, type DisciplineRecord } from '../src/payee/registry.js';
import { evaluatePayPal } from '../src/payee/paypalStatus.js';
import { simulatedStatus, SimulatedOnboarding, type OnboardingProvider, type StatusResult } from '../src/payee/onboarding.js';
import { GuardDenied } from '../src/guard.js';
import { reconcileEvent } from '../src/reconcile.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { buildApi, buildPublicApi } from '../src/routes.js';
import { setup, newCase, toVerified, approveCur, setClock, tok, TEST_AUTH, TEST_URL, type Env } from './helpers.js';

// ---------------------------------------------------------------- names
test('names: tokens ignore case, accents, initials and suffixes; "Last, First" equals "First Last"', () => {
  assert.deepEqual(nameTokens('García-López, José A., Jr.'), ['garcialopez', 'jose']);
  assert.equal(matchNames('Abbas, Issam', 'Issam A. Abbas'), 'exact');
  assert.equal(matchNames('Maria Garcia', 'Maria Garcia Lopez'), 'possible');
  assert.equal(matchNames('Maria Garcia', 'Pedro Garcia'), 'none');
  assert.equal(matchNames('Ana', 'Ana'), 'none'); // too little to match on
  assert.equal(matchNames('', 'x y'), 'none');
});
test('names: states and discipline "place" strings', () => {
  assert.equal(stateName('FL'), 'florida'); assert.equal(stateName('florida'), 'florida'); assert.equal(stateName('Atlantis'), null);
  assert.equal(placeHasState('Los Angeles, CA', 'California'), true);
  assert.equal(placeHasState('New Jersey/New York', 'NY'), true);
  assert.equal(placeHasState('Michigan', 'Florida'), false);
  assert.equal(placeHasState('Michigan', null), false);
});
test('discipline "Reinstated?" parsing is conservative', () => {
  for (const v of ['Yes - 11/5/25', 'Yes', 'yes - 5/1/25', 'Yes – 12/20/24']) assert.equal(isReinstated(v), true, v);
  for (const v of ['No', '', 'No - 6/12/25', 'Yes – 2/11/25No - 1/3/24', 'N)', 'N/A']) assert.equal(isReinstated(v), false, v);
});

// ---------------------------------------------------------------- registry (synthetic mini snapshot; no real people)
const rep = (o: Partial<RepRecord>): RepRecord => ({ name: 'Rivers, Taylor', acc_exp: '2030-01-01', acc_pending: false, rep_status: 'Active', org: 'Example Aid Org (TEST)', org_recognized: '2020-01-01', org_exp: '2031-01-01', org_pending: false, org_status: 'Active', dhs_only: false, ...o });
const dis = (o: Partial<DisciplineRecord>): DisciplineRecord => ({ name: 'Quinn Baddie', place: 'Florida', immediate_suspension: '', final_discipline: 'Disbarred', effective: '1/2/24', reinstated: 'No', ...o });
const SNAP = (reps: RepRecord[], cur: DisciplineRecord[] = [], prev: DisciplineRecord[] = []): Snapshot => ({
  manifest: { taken: '2026-11-02', source: 'TEST', roster_report_date: '2026-10-25', currently_disciplined: { url: 'u', page_date: '2026-10-26' }, previously_disciplined: { url: 'u', page_date: '2026-04-23' }, counts: {}, disclaimer: 'x' },
  representatives: reps, disciplined_current: cur, disciplined_previous: prev });
const reg = (reps: RepRecord[], cur: DisciplineRecord[] = [], prev: DisciplineRecord[] = []) => new PractitionerRegistry(SNAP(reps, cur, prev), new SimulatedBar());
const P = (o: any = {}) => ({ type: 'recognized_org_rep' as const, person_name: 'Taylor Rivers', org_name: 'Example Aid Org (TEST)', practice_state: 'Florida', bar_number: null, ...o });
const TODAY = new Date('2026-11-02T12:00:00Z');

test('registry: accredited rep of the named org passes; shows expirations, snapshot dates, bilingual reasons', () => {
  const c = reg([rep({})]).check(P(), TODAY);
  assert.equal(c.status, 'pass'); assert.equal(c.simulated, false);
  assert.equal(c.details.accreditation!.accreditation_expires, '2030-01-01'); assert.equal(c.details.accreditation!.organization_recognition_expires, '2031-01-01');
  assert.equal(c.details.snapshot.eoir_roster_report_date, '2026-10-25'); assert.equal(c.details.snapshot.eoir_currently_disciplined_page_date, '2026-10-26');
  assert.match(c.reason_en, /2030-01-01/); assert.match(c.reason_es, /vence el 2030-01-01/);
});
test('registry: asterisk (pending renewal) is valid with a note; expired and not pending fails; DHS-only is noted', () => {
  const pend = reg([rep({ acc_exp: '2026-02-28', acc_pending: true })]).check(P(), TODAY);
  assert.equal(pend.status, 'pass'); assert.equal(pend.details.accreditation!.accreditation_pending_renewal, true); assert.match(pend.reason_en, /\*pending renewal/);
  assert.equal(reg([rep({ acc_exp: '2026-02-28' })]).check(P(), TODAY).status, 'fail');
  assert.equal(reg([rep({ org_exp: '2026-01-01' })]).check(P(), TODAY).status, 'fail');
  assert.equal(reg([rep({ org_exp: '2026-01-01', org_pending: true })]).check(P(), TODAY).status, 'pass');
  const dhs = reg([rep({ dhs_only: true })]).check(P(), TODAY); assert.equal(dhs.status, 'pass'); assert.match(dhs.reason_en, /DHS-only/); assert.match(dhs.reason_es, /solo para DHS/);
});
test('registry: not found, wrong organization, inactive status fail; a similar name needs human review', () => {
  assert.equal(reg([]).check(P(), TODAY).status, 'fail');
  assert.equal(reg([rep({ org: 'Some Other Org' })]).check(P(), TODAY).status, 'fail', 'reps may practice only through their own recognized org');
  assert.equal(reg([rep({ rep_status: 'Inactive' })]).check(P(), TODAY).status, 'fail');
  assert.equal(reg([rep({ org_status: 'Suspended' })]).check(P(), TODAY).status, 'fail');
  const sim = reg([rep({ name: 'Rivers, Taylor Morgan' })]).check(P(), TODAY); assert.equal(sim.status, 'needs_review'); assert.match(sim.reason_en, /human must review/);
});
test('registry: a CONFIRMED currently-disciplined match (same name AND state) is a HARD FAIL even if listed on the roster', () => {
  const r = reg([rep({ name: 'Baddie, Quinn' })], [dis({})]);
  const c = r.check(P({ person_name: 'Quinn Baddie', practice_state: 'FL' }), TODAY);
  assert.equal(c.status, 'fail'); assert.match(c.reason_en, /HARD FAIL/); assert.match(c.reason_es, /FALLA DEFINITIVA/); assert.equal(c.details.discipline.current, 'confirmed');
  assert.equal(r.check({ type: 'attorney', person_name: 'Quinn Baddie', org_name: null, practice_state: 'Florida', bar_number: 'SIM-100001' }, TODAY).status, 'fail', 'applies to attorneys too');
});
test('registry: same name in a DIFFERENT state, or unknown state, is only "possible" -> needs_review, never an auto-block', () => {
  const r = reg([rep({ name: 'Baddie, Quinn' })], [dis({ place: 'Michigan' })]);
  const c = r.check(P({ person_name: 'Quinn Baddie', practice_state: 'Florida' }), TODAY);
  assert.equal(c.status, 'needs_review'); assert.equal(c.details.discipline.current, 'possible');
  assert.equal(r.check(P({ person_name: 'Quinn Baddie', practice_state: null }), TODAY).status, 'needs_review');
  assert.equal(reg([rep({ name: 'Baddie, Quinn' })], [dis({ name: 'Quinn R. Baddie Jr' })]).check(P({ person_name: 'Quinn Baddie' }), TODAY).details.discipline.current, 'confirmed', 'initials/suffix differences still match exactly');
});
test('registry: reinstated or previously disciplined is informational only', () => {
  const r1 = reg([rep({ name: 'Baddie, Quinn' })], [dis({ reinstated: 'Yes - 4/27/26' })]).check(P({ person_name: 'Quinn Baddie' }), TODAY);
  assert.equal(r1.status, 'pass'); assert.ok(r1.details.discipline.note_en);
  const r2 = reg([rep({ name: 'Baddie, Quinn' })], [], [dis({ reinstated: 'Yes - 1/7/16' })]).check(P({ person_name: 'Quinn Baddie' }), TODAY);
  assert.equal(r2.status, 'pass'); assert.equal(r2.details.discipline.previous, 'confirmed'); assert.match(r2.details.discipline.note_en!, /previously disciplined/);
});
test('registry: attorneys use the SIMULATED bar lookup (labeled, with the official link); no live bar data', () => {
  const att = (o: any = {}) => ({ type: 'attorney' as const, person_name: 'Alex Demolawyer', org_name: null, practice_state: 'Florida', bar_number: 'SIM-100001', ...o });
  const ok = reg([]).check(att(), TODAY);
  assert.equal(ok.status, 'pass'); assert.equal(ok.simulated, true); assert.equal(ok.route, 'attorney_bar_simulated');
  assert.match(ok.reason_en, /SIMULATED/); assert.match(ok.reason_es, /SIMULAD/); assert.ok(ok.details.manual_check_url!.startsWith('https://www.floridabar.org/directories/find-mbr/'));
  assert.equal(reg([]).check(att({ bar_number: 'SIM-100002', person_name: 'Sam Suspended' }), TODAY).status, 'fail');
  assert.equal(reg([]).check(att({ bar_number: 'SIM-100003', person_name: 'Retired Rita' }), TODAY).status, 'fail');
  assert.equal(reg([]).check(att({ bar_number: 'SIM-999999' }), TODAY).status, 'fail');
  assert.equal(reg([]).check(att({ person_name: 'Someone Else' }), TODAY).status, 'fail', 'bar number must belong to that name');
  assert.equal(reg([]).check(att({ bar_number: null }), TODAY).status, 'fail');
  const bar = JSON.parse(readFileSync(new URL('../data/bar/simulated_bar.json', import.meta.url), 'utf8'));
  assert.equal(bar.simulated, true); assert.ok(bar.members.every((m: any) => m.bar_number.startsWith('SIM-')), 'fixture only: no real bar numbers');
});
test('registry: no credentials on file fails with the manual-check link', () => {
  const c = reg([]).check({ type: 'none', person_name: 'Pat', org_name: null, practice_state: null, bar_number: null }, TODAY);
  assert.equal(c.status, 'fail'); assert.ok(c.details.manual_check_url);
});
test('real EOIR snapshot: dated, counts match the official pages, a listed rep resolves, a disciplined name hard-fails', () => {
  const r = PractitionerRegistry.load({ overlayFile: null });
  const m = r.snapshot.manifest;
  assert.equal(m.roster_report_date, '2026-10-25'); assert.equal(m.currently_disciplined.page_date, '2026-10-26');
  assert.equal(r.snapshot.representatives.length, m.counts.accredited_representatives); assert.equal(r.snapshot.disciplined_current.length, m.counts.currently_disciplined);
  assert.ok(m.counts.accredited_representatives > 2000 && m.counts.currently_disciplined > 1000);
  const listed = r.snapshot.representatives.find(x => x.rep_status === 'Active' && x.org_status === 'Active' && x.acc_exp > '2027-01-01' && x.org_exp > '2027-01-01' && !r.snapshot.disciplined_current.some(d => matchNames(d.name, x.name) !== 'none'))!;
  const ok = r.check({ type: 'recognized_org_rep', person_name: listed.name, org_name: listed.org, practice_state: null, bar_number: null }, TODAY);
  assert.equal(ok.status, 'pass', ok.reason_en);
  const bad = r.snapshot.disciplined_current.find(d => !isReinstated(d.reinstated) && /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(d.place) && stateName(d.place) && d.name.split(' ').length === 2)!;
  const hard = r.check({ type: 'attorney', person_name: bad.name, org_name: null, practice_state: bad.place, bar_number: 'SIM-100001' }, TODAY);
  assert.equal(hard.status, 'fail'); assert.match(hard.reason_en, /HARD FAIL/);
});

// ---------------------------------------------------------------- PayPal status check
const OKDOC = { payments_receivable: true, primary_email_confirmed: true, oauth_integrations: [{ oauth_third_party: [{ scopes: ['https://uri.paypal.com/services/payments/payment/authcapture', 'https://uri.paypal.com/services/payments/refund'] }] }] };
test('PayPal check: pass only if payments_receivable AND primary_email_confirmed AND authcapture+refund permissions', () => {
  assert.equal(evaluatePayPal(OKDOC, 'live').status, 'pass');
  assert.equal(evaluatePayPal({ ...OKDOC, payments_receivable: false }, 'live').status, 'fail');
  assert.equal(evaluatePayPal({ ...OKDOC, primary_email_confirmed: false }, 'live').status, 'fail');
  assert.equal(evaluatePayPal({ ...OKDOC, primary_email_confirmed: undefined }, 'live').status, 'fail');
  assert.equal(evaluatePayPal({ ...OKDOC, oauth_integrations: [] }, 'live').status, 'fail');
  assert.equal(evaluatePayPal({ ...OKDOC, oauth_integrations: [{ oauth_third_party: [{ scopes: ['https://uri.paypal.com/services/payments/payment/authcapture'] }] }] }, 'live').status, 'fail', 'refund permission missing');
  const none = evaluatePayPal(null, 'none'); assert.equal(none.status, 'fail'); assert.ok(none.reason_en && none.reason_es);
  const bad = evaluatePayPal({ ...OKDOC, payments_receivable: false, primary_email_confirmed: false }, 'live');
  assert.equal(bad.details.sub_checks.filter(s => s.status === 'fail').length, 2);
  assert.equal(evaluatePayPal(OKDOC, 'live').simulated, false); assert.match(evaluatePayPal(OKDOC, 'simulated').reason_en, /SIMULATED/); assert.match(evaluatePayPal(OKDOC, 'simulated').reason_es, /SIMULADO/);
});
test('simulated onboarding: SIMOK is ready, SIMBAD is not, other ids have no status; PayPal-shaped, no PII', () => {
  assert.equal(evaluatePayPal(simulatedStatus('SIMOKXYZ', 't'), 'simulated').status, 'pass');
  assert.equal(evaluatePayPal(simulatedStatus('SIMBADXYZ', 't'), 'simulated').status, 'fail');
  assert.equal(simulatedStatus('REALMERCH001', 't'), null); assert.equal(simulatedStatus(null, 't'), null);
});

// ---------------------------------------------------------------- DB-backed
const opts = { skip: TEST_URL ? false : 'DATABASE_URL_TEST not set' };
let e: Env; let pid: Record<string, number> = {};
before(async () => { if (!TEST_URL) return; e = await setup(undefined, { coolingHours: 72 }); for (const u of ['provider_demo', 'provider_two']) pid[u] = (await e.db.query('SELECT p.id FROM providers p JOIN users x ON x.id = p.user_id WHERE x.username = $1', [u])).rows[0].id; });
after(async () => { if (!TEST_URL) return; await e.close(); });
const audits = async (caseId: string, action: string) => (await e.db.query('SELECT * FROM audit_log WHERE case_id = $1 AND action = $2', [caseId, action])).rows;

test('verify: both checks are returned separately with bilingual reasons, SIMULATED labels, snapshot dates; snapshots are append-only', opts, async () => {
  const v = await e.payee.verifyProvider(pid.provider_demo, { trigger: 'test' });
  assert.equal(v.verified, true); assert.equal(v.checks.length, 2);
  const [pp, pr] = v.checks; assert.equal(pp.id, 'paypal_ready'); assert.equal(pr.id, 'authorized_to_practice');
  assert.equal(pp.status, 'pass'); assert.equal(pp.simulated, true); assert.match(pp.reason_en, /SIMULATED/); assert.match(pp.reason_es, /SIMULADO/);
  assert.equal(pr.status, 'pass'); assert.ok(pr.reason_en && pr.reason_es);
  assert.equal(v.source, 'PayPal seller onboarding status'); assert.equal(v.snapshot.eoir_roster_report_date, '2026-10-25');
  assert.match(v.merchant_id_masked!, /^SIM…001$/); assert.ok(!JSON.stringify(v).includes('SIMOKDEMO0001'), 'merchant id is masked');
  assert.match(v.disclaimer_en, /does not guarantee/); assert.ok(!/escrow/i.test(JSON.stringify(v)));
  const bad = await e.payee.verifyProvider(pid.provider_two);
  assert.equal(bad.verified, false); assert.equal(bad.checks[0].status, 'fail'); assert.equal(bad.checks[1].status, 'fail');
  assert.match(bad.summary_en, /Not verified/); assert.match(bad.summary_es, /No verificado/);
  await assert.rejects(() => e.db.query('UPDATE provider_verifications SET verified = true WHERE id = $1', [bad.verification_id]));
  await assert.rejects(() => e.db.query('DELETE FROM provider_verifications WHERE id = $1', [bad.verification_id]));
});
test('verify: one check failing is enough to fail (PayPal ready but not authorized to practice, and the reverse)', opts, async () => {
  const stub = (ok: boolean): OnboardingProvider => ({ createReferral: async () => ({ mode: 'simulated', action_url: null, note: '' }), status: async () => ({ mode: 'simulated', doc: simulatedStatus(ok ? 'SIMOKX' : 'SIMBADX', 't'), merchant_id: 'X', note: '' }) });
  const a = await setup(undefined, { onboarding: stub(true) });
  try { const p2 = (await a.db.query(`SELECT id FROM providers WHERE practitioner_type = 'none'`)).rows[0].id;
    const v = await a.payee.verifyProvider(p2, { merchantId: 'ANYTHING0001' }); assert.equal(v.checks[0].status, 'pass'); assert.equal(v.checks[1].status, 'fail'); assert.equal(v.verified, false); } finally { await a.close(); }
  const b = await setup(undefined, { onboarding: stub(false) });
  try { const p1 = (await b.db.query(`SELECT id FROM providers WHERE practitioner_type = 'recognized_org_rep'`)).rows[0].id;
    const v = await b.payee.verifyProvider(p1, { merchantId: 'ANYTHING0001' }); assert.equal(v.checks[0].status, 'fail'); assert.equal(v.checks[1].status, 'pass'); assert.equal(v.verified, false); } finally { await b.close(); }
});
test('verify: recent snapshots are reused only when refreshSeconds allows', opts, async () => {
  const a = await setup(undefined); // refreshSeconds 0 in tests: always fresh
  try { const p = (await a.db.query(`SELECT id FROM providers LIMIT 1`)).rows[0].id; const v1 = await a.payee.publicVerify(p); const v2 = await a.payee.publicVerify(p); assert.notEqual(v1.verification_id, v2.verification_id); } finally { await a.close(); }
});

test('binding: the case binds the provider merchant at creation; getCase shows only a masked id; the binding is immutable in the database', opts, async () => {
  const c = await newCase(e); const cs = await e.svc.getCase(e.provider, c.id);
  assert.equal(cs.payee.immutable, true); assert.equal(cs.payee.mode, 'simulated'); assert.equal(cs.payee.merchant_id_masked, 'SIM…001'); assert.ok(!JSON.stringify(cs).includes('SIMOKDEMO0001'));
  assert.equal((await audits(c.id, 'payee.bound')).length, 1);
  await assert.rejects(() => e.db.query(`UPDATE cases SET payee_merchant_id = 'ATTACKER00001' WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(() => e.db.query(`UPDATE cases SET payee_mode = 'live' WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(() => e.db.query(`UPDATE cases SET payee_merchant_id = NULL WHERE id = $1`, [c.id]), /immutable/);
  await e.db.query(`UPDATE cases SET title = 'renamed' WHERE id = $1`, [c.id]); // other columns are free
  // setting the GUC outside the approved flow from another session does nothing
  const cl = await e.db.pool.connect(); try { await cl.query('BEGIN'); await cl.query(`SELECT set_config('gp.payee_change', 'nope', true)`); await assert.rejects(() => cl.query(`UPDATE cases SET payee_merchant_id = 'X12345678' WHERE id = $1`, [c.id])); } finally { await cl.query('ROLLBACK').catch(() => {}); cl.release(); }
  const p = (await e.db.query(`SELECT payee_merchant_id FROM cases WHERE id = $1`, [c.id])).rows[0]; assert.equal(p.payee_merchant_id, 'SIMOKDEMO0001');
});
test('funding refuses an unverified payee (409, bilingual reasons) and never calls PayPal; the stamped payee is on the payment', opts, async () => {
  // provider_two cannot even create a case's funding: both checks fail
  const c2 = await e.svc.createCase(e.provider2, { title: 'Unverified provider (synthetic)', milestones: [{ title: 'M1', amount: '10.00' }] });
  const before = e.fake.calls.length;
  await assert.rejects(() => e.svc.openOrder(e.family, c2.milestones[0].id, { payment_source: 'card' }), (x: any) => x.status === 409 && x.code === 'payee_not_verified' && /Not verified/.test(x.message) && /No verificado/.test(x.message) && x.extra.checks.length === 2);
  assert.equal(e.fake.calls.length, before, 'PayPal was never called');
  const c = await newCase(e); await e.svc.openOrder(e.family, c.milestones[0].id, { payment_source: 'card' });
  const pay = (await e.db.query('SELECT payee_merchant_id, payee_mode FROM payments WHERE milestone_id = $1', [c.milestones[0].id])).rows[0];
  assert.deepEqual(pay, { payee_merchant_id: 'SIMOKDEMO0001', payee_mode: 'simulated' });
  const order = e.fake.calls.filter(x => x.path === '/v2/checkout/orders').pop()!; assert.equal(order.body.purchase_units[0].payee, undefined, 'simulated payees are not sent to PayPal');
});
test('GUARD BACKSTOP: a failing payee verification after funding blocks approve/capture even if the service is bypassed', opts, async () => {
  const f = await toVerified(e); const caps = e.fake.realCaptures;
  const prov = (await e.db.query('SELECT provider_id FROM cases WHERE id = $1', [f.caseId])).rows[0].provider_id;
  await e.db.query(`UPDATE provider_onboarding SET consent_revoked_at = now() WHERE provider_id = $1`, [prov]);
  await e.payee.verifyProvider(prov, { trigger: 'test revoke' });
  await assert.rejects(() => approveCur(e, f.id), (x: any) => x.status === 409 && x.code === 'payee_not_verified');
  const m = (await e.db.query('SELECT state FROM milestones WHERE id = $1', [f.id])).rows[0]; assert.equal(m.state, 'verified');
  // bypass the service: call the guard directly with the family actor (approval row present) -> still denied by the payee rule
  const sha = (await e.db.query('SELECT id, sha256 FROM proofs WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1', [f.id])).rows[0];
  await e.db.query(`INSERT INTO approvals (milestone_id, user_id, decision, proof_id, proof_sha256) VALUES ($1,$2,'approve',$3,$4)`, [f.id, e.family.userId, sha.id, sha.sha256]);
  const pay = (await e.db.query('SELECT current_authorization_id FROM payments WHERE milestone_id = $1', [f.id])).rows[0];
  await assert.rejects(() => e.guarded.capture({ actor: e.family, milestone: { id: f.id, state: 'verified', providerUserId: e.provider.userId! }, amount: '25.00', attempt: 1 }, pay.current_authorization_id, 'USD'), (x: any) => x instanceof GuardDenied && /payee/.test(x.reason));
  assert.equal(e.fake.realCaptures, caps);
  // a void is still possible (money can always be released back)
  await e.db.query(`UPDATE provider_onboarding SET consent_revoked_at = NULL WHERE provider_id = $1`, [prov]); await e.payee.verifyProvider(prov);
});
test('GUARD BACKSTOP: a stale verification (older than the max age) blocks the guard', opts, async () => {
  const f = await toVerified(e); const prov = (await e.db.query('SELECT provider_id FROM cases WHERE id = $1', [f.caseId])).rows[0].provider_id;
  await e.payee.verifyProvider(prov);
  await e.db.query(`ALTER TABLE provider_verifications DISABLE TRIGGER provider_verifications_append_only`);
  try { await e.db.query(`UPDATE provider_verifications SET checked_at = now() - interval '3 days' WHERE provider_id = $1`, [prov]);
    const sha = (await e.db.query('SELECT id, sha256 FROM proofs WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1', [f.id])).rows[0];
    await e.db.query(`INSERT INTO approvals (milestone_id, user_id, decision, proof_id, proof_sha256) VALUES ($1,$2,'approve',$3,$4)`, [f.id, e.family.userId, sha.id, sha.sha256]);
    const pay = (await e.db.query('SELECT current_authorization_id FROM payments WHERE milestone_id = $1', [f.id])).rows[0];
    await assert.rejects(() => e.guarded.capture({ actor: e.family, milestone: { id: f.id, state: 'verified', providerUserId: e.provider.userId! }, amount: '25.00', attempt: 1 }, pay.current_authorization_id, 'USD'), (x: any) => x instanceof GuardDenied && /out of date/.test(x.reason));
  } finally { await e.db.query(`ALTER TABLE provider_verifications ENABLE TRIGGER provider_verifications_append_only`); }
  // the service re-checks first, so the normal path just works again
  await e.svc.approve(e.family, f.id, { proof_sha256: (await e.db.query('SELECT sha256 FROM proofs WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1', [f.id])).rows[0].sha256 });
  assert.equal((await e.db.query('SELECT state FROM milestones WHERE id = $1', [f.id])).rows[0].state, 'captured');
});

test('change flow: re-verification + family approval + cooling delay (case clock) + audit; money frozen meanwhile; roles enforced', opts, async () => {
  const c = await newCase(e); const mid = c.milestones[0].id;
  // roles
  await assert.rejects(() => e.payee.requestChange(e.family, c.id, 'SIMOKNEWPAYEE1'), (x: any) => x.status === 403);
  await assert.rejects(() => e.payee.requestChange(e.provider2, c.id, 'SIMOKNEWPAYEE1'), (x: any) => x.status === 403);
  await assert.rejects(() => e.payee.requestChange(e.provider, c.id, 'bad id!'), (x: any) => x.status === 400);
  await assert.rejects(() => e.payee.requestChange(e.provider, c.id, 'SIMOKDEMO0001'), (x: any) => x.status === 400, 'same payee');
  // the new payee must pass BOTH checks
  await assert.rejects(() => e.payee.requestChange(e.provider, c.id, 'SIMBADOTHER001'), (x: any) => x.status === 409 && x.code === 'payee_not_verified');
  const ch = await e.payee.requestChange(e.provider, c.id, 'SIMOKNEWPAYEE1');
  assert.equal(ch.status, 'pending'); assert.ok(new Date(ch.effective_after).getTime() - Date.now() > 71 * 3600_000);
  await assert.rejects(() => e.payee.requestChange(e.provider, c.id, 'SIMOKNEWPAYEE2'), (x: any) => x.status === 409);
  // money is frozen
  await assert.rejects(() => e.svc.openOrder(e.family, mid, { payment_source: 'card' }), (x: any) => x.code === 'payee_change_pending');
  // nothing happens without family approval, then the cooling delay holds
  await assert.rejects(() => e.payee.applyChange(e.provider, c.id), (x: any) => x.code === 'family_approval_required');
  await assert.rejects(() => e.payee.approveChange(e.provider, c.id), (x: any) => x.status === 403);
  await e.payee.approveChange(e.family, c.id);
  await assert.rejects(() => e.payee.applyChange(e.provider, c.id), (x: any) => x.code === 'cooling_delay');
  await setClock(e, c.id, 2); await assert.rejects(() => e.payee.applyChange(e.provider, c.id), (x: any) => x.code === 'cooling_delay');
  assert.deepEqual(await e.payee.tickChanges(), { applied: 0, blocked: 0 });
  await setClock(e, c.id, 4);
  assert.deepEqual(await e.payee.tickChanges(), { applied: 1, blocked: 0 }, 'the background job applies it once the delay has passed');
  const cs = await e.svc.getCase(e.family, c.id);
  assert.equal(cs.payee.merchant_id_masked, 'SIM…EE1'); assert.equal(cs.payee.change!.status, 'applied');
  for (const a of ['payee.change_requested', 'payee.change_approved', 'payee.change_applied']) assert.equal((await audits(c.id, a)).length, 1, a);
  // direct SQL still cannot change it, and funding works for the new payee
  await assert.rejects(() => e.db.query(`UPDATE cases SET payee_merchant_id = 'SIMOKDEMO0001' WHERE id = $1`, [c.id]), /immutable/);
  await e.svc.openOrder(e.family, mid, { payment_source: 'card' });
  assert.equal((await e.db.query('SELECT payee_merchant_id FROM payments WHERE milestone_id = $1', [mid])).rows[0].payee_merchant_id, 'SIMOKNEWPAYEE1');
});
test('change flow: cancel unfreezes; a new payee that fails re-verification at apply time is blocked and audited', opts, async () => {
  const c = await newCase(e);
  await e.payee.requestChange(e.provider, c.id, 'SIMOKCANCEL001'); await e.payee.cancelChange(e.family, c.id);
  await e.svc.openOrder(e.family, c.milestones[0].id, { payment_source: 'card' }); // unfrozen
  const d = await newCase(e); const prov = (await e.db.query('SELECT provider_id FROM cases WHERE id = $1', [d.id])).rows[0].provider_id;
  await e.payee.requestChange(e.provider, d.id, 'SIMOKLATER0001'); await e.payee.approveChange(e.family, d.id); await setClock(e, d.id, 4);
  await e.db.query(`UPDATE provider_onboarding SET consent_revoked_at = now() WHERE provider_id = $1`, [prov]); // provider now fails (new merchant is evaluated the same way: revoked only applies to the primary merchant)
  await e.db.query(`UPDATE providers SET practitioner_type = 'none' WHERE id = $1`, [prov]); // practice check now fails for the same provider
  try {
    await assert.rejects(() => e.payee.applyChange(e.provider, d.id), (x: any) => x.code === 'payee_not_verified');
    assert.equal((await audits(d.id, 'payee.change_blocked')).length, 1);
    assert.equal((await e.db.query('SELECT payee_merchant_id FROM cases WHERE id = $1', [d.id])).rows[0].payee_merchant_id, 'SIMOKDEMO0001');
  } finally { await e.db.query(`UPDATE providers SET practitioner_type = 'recognized_org_rep' WHERE id = $1`, [prov]); await e.db.query(`UPDATE provider_onboarding SET consent_revoked_at = NULL WHERE provider_id = $1`, [prov]); }
});

// A LIVE-mode onboarding stub: merchant ids that start with LIVE are "real" sellers that PayPal reports as ready.
const liveStub = (): OnboardingProvider => ({
  createReferral: async (t) => ({ mode: 'live', action_url: `https://sandbox.paypal.test/onboard/${t}`, note: 'REAL (stub)' }),
  status: async (t, m): Promise<StatusResult> => m?.startsWith('LIVE') ? { mode: 'live', doc: { ...OKDOC, merchant_id: m, tracking_id: t }, merchant_id: m, note: 'live' } : new SimulatedOnboarding().status(t, m),
});
test('live mode: the order carries payee.merchant_id (funds go to the provider, not the platform); onboarding start returns the PayPal link', opts, async () => {
  const a = await setup(undefined, { onboarding: liveStub() });
  try {
    const prov = (await a.db.query(`SELECT id FROM providers WHERE practitioner_type = 'recognized_org_rep'`)).rows[0].id;
    await a.db.query(`UPDATE provider_onboarding SET merchant_id = 'LIVEMERCH0001', referral_mode = 'live' WHERE provider_id = $1`, [prov]);
    const o = await a.payee.startOnboarding(a.provider); assert.equal(o.simulated, false); assert.match(o.action_url!, /onboard\/gp-provider-/); assert.equal(o.tracking_id, `gp-provider-${prov}`);
    const c = await newCase(a); assert.equal((await a.svc.getCase(a.provider, c.id)).payee.mode, 'live');
    await a.svc.openOrder(a.family, c.milestones[0].id, { payment_source: 'card' });
    const order = a.fake.calls.filter(x => x.path === '/v2/checkout/orders').pop()!;
    assert.deepEqual(order.body.purchase_units[0].payee, { merchant_id: 'LIVEMERCH0001' });
    assert.equal((await a.db.query('SELECT payee_mode FROM payments WHERE milestone_id = $1', [c.milestones[0].id])).rows[0].payee_mode, 'live');
  } finally { await a.close(); }
});
test('webhooks: MERCHANT.ONBOARDING.COMPLETED binds + verifies; MERCHANT.PARTNER-CONSENT.REVOKED freezes funds; both are idempotent through reconcileEvent', opts, async () => {
  const a = await setup(undefined, { onboarding: liveStub() });
  try {
    const prov = (await a.db.query(`SELECT id FROM providers WHERE practitioner_type = 'recognized_org_rep'`)).rows[0].id;
    await a.db.query(`UPDATE provider_onboarding SET merchant_id = NULL, referral_mode = NULL WHERE provider_id = $1`, [prov]);
    const c = await newCase(a); assert.equal((await a.svc.getCase(a.provider, c.id)).payee.immutable, false, 'no merchant yet: unbound');
    await assert.rejects(() => a.svc.openOrder(a.family, c.milestones[0].id, { payment_source: 'card' }), (x: any) => x.code === 'payee_not_verified');
    const ev = async (id: string, type: string, resource: any, verified = true) => { await a.db.query('INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload) VALUES ($1,$2,$3,$4)', [id, type, verified, JSON.stringify({ id, event_type: type, resource })]); return reconcileEvent(a.db, id, new Date(), a.payee); };
    const unv = await ev('WH-U', 'MERCHANT.ONBOARDING.COMPLETED', { tracking_id: `gp-provider-${prov}`, merchant_id: 'LIVEMERCH0009' }, false); assert.equal(unv.outcome, 'ignored');
    assert.equal((await a.db.query('SELECT merchant_id FROM provider_onboarding WHERE provider_id = $1', [prov])).rows[0].merchant_id, null, 'unverified webhooks do nothing');
    const r1 = await ev('WH-1', 'MERCHANT.ONBOARDING.COMPLETED', { tracking_id: `gp-provider-${prov}`, merchant_id: 'LIVEMERCH0009' });
    assert.equal(r1.outcome, 'applied'); assert.match(r1.note, /verified=true/);
    assert.equal((await a.db.query('SELECT merchant_id FROM provider_onboarding WHERE provider_id = $1', [prov])).rows[0].merchant_id, 'LIVEMERCH0009');
    assert.equal((await a.svc.getCase(a.provider, c.id)).payee.merchant_id_masked, 'LIV…009', 'the waiting case is now bound');
    assert.equal((await reconcileEvent(a.db, 'WH-1', new Date(), a.payee)).outcome, 'skipped', 'already processed');
    await a.svc.openOrder(a.family, c.milestones[0].id, { payment_source: 'card' }); // funding works now
    const r2 = await ev('WH-2', 'MERCHANT.PARTNER-CONSENT.REVOKED', { merchant_id: 'LIVEMERCH0009' }); assert.match(r2.note, /verified=false/);
    const d = await newCase(a);
    await assert.rejects(() => a.svc.openOrder(a.family, d.milestones[0].id, { payment_source: 'card' }), (x: any) => x.code === 'payee_not_verified' && /revoked/i.test(JSON.stringify(x.extra)));
    const r3 = await ev('WH-3', 'MERCHANT.ONBOARDING.COMPLETED', { tracking_id: `gp-provider-${prov}`, merchant_id: 'LIVEMERCH0009' }); assert.match(r3.note, /verified=true/);
    await a.svc.openOrder(a.family, d.milestones[0].id, { payment_source: 'card' });
    assert.equal((await ev('WH-4', 'MERCHANT.ONBOARDING.COMPLETED', { tracking_id: 'gp-provider-9999' })).outcome, 'ignored');
  } finally { await a.close(); }
});

// ---------------------------------------------------------------- HTTP
test('API: GET /api/verify-payee/:id is public (no login), shows both checks + dates, is rate limited; POST needs auth and a role', opts, async () => {
  const srv = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, TEST_AUTH, e.payee), publicApi: buildPublicApi(e.payee) }).listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/api/verify-payee/${pid.provider_demo}`); assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.verified, true); assert.equal(j.source, 'PayPal seller onboarding status'); assert.equal(j.checks.length, 2);
    assert.deepEqual(j.checks.map((c: any) => c.id), ['paypal_ready', 'authorized_to_practice']);
    assert.ok(j.checked_at && j.snapshot.eoir_roster_report_date === '2026-10-25' && j.snapshot.eoir_currently_disciplined_page_date === '2026-10-26');
    assert.ok(j.bar_lookup_url.startsWith('https://www.floridabar.org')); assert.equal(j.simulated, true);
    assert.equal(j.checks[1].details.accreditation.accreditation_expires, '2028-06-30'); assert.equal(j.checks[1].details.accreditation.synthetic, true);
    assert.ok(!JSON.stringify(j).includes('SIMOKDEMO0001') && !/token|secret/i.test(JSON.stringify(j)));
    const two: any = await (await fetch(`${base}/api/verify-payee/${pid.provider_two}`)).json(); assert.equal(two.verified, false);
    assert.equal((await fetch(`${base}/api/verify-payee/99999`)).status, 404); assert.equal((await fetch(`${base}/api/verify-payee/abc`)).status, 404);
    const post = (u: string | null, body: any) => fetch(`${base}/api/verify-payee`, { method: 'POST', headers: { 'content-type': 'application/json', ...(u ? { authorization: tok(u) } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(null, { provider_id: pid.provider_demo, merchant_id: 'SIMOKDEMO0001' })).status, 401);
    assert.equal((await post('family_demo', { provider_id: pid.provider_demo, merchant_id: 'SIMOKDEMO0001' })).status, 403);
    assert.equal((await post('provider_two', { provider_id: pid.provider_demo, merchant_id: 'SIMOKDEMO0001' })).status, 403, "a provider can only check their own");
    assert.equal((await post('provider_demo', { provider_id: pid.provider_demo, merchant_id: 'x' })).status, 400);
    const ok: any = await (await post('provider_demo', { provider_id: pid.provider_demo, merchant_id: 'SIMOKDEMO0001' })).json(); assert.equal(ok.verified, true);
    // change endpoints exist and enforce roles over HTTP
    const call = (u: string, path: string, body: any = {}) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: tok(u) }, body: JSON.stringify(body) });
    const c = await newCase(e);
    assert.equal((await call('family_demo', `/cases/${c.id}/payee-change`, { new_merchant_id: 'SIMOKVIAHTTP1' })).status, 403);
    assert.equal((await call('provider_demo', `/cases/${c.id}/payee-change`, { new_merchant_id: 'SIMOKVIAHTTP1' })).status, 201);
    assert.equal((await call('provider_demo', `/cases/${c.id}/payee-change/approve`)).status, 403);
    assert.equal((await call('family_demo', `/cases/${c.id}/payee-change/approve`)).status, 200);
    assert.equal((await call('family_demo', `/cases/${c.id}/payee-change/apply`)).status, 409);
    const info: any = await (await fetch(`${base}/api/cases/${c.id}/payee`, { headers: { authorization: tok('family_demo') } })).json(); assert.equal(info.change.status, 'approved');
    assert.equal((await call('provider_demo', '/provider/onboarding')).status, 201);
    for (let i = 0; i < 70; i++) await fetch(`${base}/api/verify-payee/${pid.provider_demo}`);
    assert.equal((await fetch(`${base}/api/verify-payee/${pid.provider_demo}`)).status, 429);
  } finally { srv.close(); }
});

test('copy: the word "escrow" appears nowhere in source, data or docs', () => {
  const hits: string[] = [];
  const walk = (dir: URL) => { for (const f of readdirSync(dir)) { const u = new URL(f, dir); if (f === 'node_modules' || f === '.git') continue; const s = statSync(u); if (s.isDirectory()) walk(new URL(f + '/', dir)); else if (/\.(ts|json|md|html|js|py|txt|yml|yaml)$/.test(f) && !/package-lock|snapshot\.json|\.test\.ts$/.test(f) && /escrow/i.test(readFileSync(u, 'utf8'))) hits.push(u.pathname); } };
  walk(new URL('../', import.meta.url)); assert.deepEqual(hits, []);
});
