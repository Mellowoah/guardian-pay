import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TEST_URL, setup, type Env } from './helpers.js';
import { HttpError } from '../src/repo.js';
import { fixtureExtractor, noExtractor, type Extractor } from '../src/verify/extraction.js';
import { clock } from '../src/clock.js';

const opts = { skip: TEST_URL ? false : 'DATABASE_URL_TEST not set' };
const fx = (n: string) => readFileSync(new URL(`./fixtures/proofs/${n}.png`, import.meta.url));
const code = async (p: Promise<unknown>) => { try { await p; return 'no-error'; } catch (e) { return e instanceof HttpError ? `${e.status}:${e.code}` : `x:${(e as Error).message}`; } };

// A call-counting wrapper so tests can see retries.
function counting(inner: Extractor, failFirst = 0) { let calls = 0; return { get calls() { return calls; }, name: 'test:' + inner.name, async extract(b: Buffer, m: string) { calls++; if (calls <= failFirst) throw new Error('model unavailable (test)'); return inner.extract(b, m); } } as Extractor & { calls: number }; }

async function fundedCase(e: Env, doc = 'receipt_notice') {
  // case created "now" in the test clock; fixtures' dates are in 2026, so set the case start before them via SQL
  const c = await e.svc.createCase(e.provider, { title: 'Proof test (synthetic)', beneficiary_name: 'Mateo Reyes', case_type: 'Family petition (synthetic)',
    milestones: [{ title: 'M1', amount: '25.00', form_type: 'I-130', document_type: doc }] });
  await e.db.query(`UPDATE cases SET created_at = '2026-01-15T00:00:00Z' WHERE id = $1`, [c.id]);
  const id = c.milestones[0].id; await e.svc.openOrder(e.family, id, { payment_source: 'card' });
  return { caseId: c.id, id };
}
const upload = (e: Env, id: string, name: string) => e.svc.submitProof(e.provider, id, { file_base64: fx(name).toString('base64'), filename: name + '.png' });
const proofRow = async (e: Env, id: string) => (await e.db.query('SELECT * FROM proofs WHERE milestone_id = $1', [id])).rows[0];
const state = async (e: Env, id: string) => (await e.db.query('SELECT state FROM milestones WHERE id = $1', [id])).rows[0].state;

describe('db: AI proof check pipeline', opts, () => {
  let e: Env; const ext = counting(fixtureExtractor);
  before(async () => { e = await setup(ext); clock.setOffsetDays(0); }); after(async () => { await e.close(); });

  test('upload stores bytes + sha256, moves to proof_submitted, runs the check; recommendation is advisory ONLY (never auto-approves)', async () => {
    const f = await fundedCase(e); const bytes = fx('good_receipt_notice');
    const r = await upload(e, f.id, 'good_receipt_notice');
    assert.equal(r.milestone.state, 'proof_submitted'); assert.equal(r.verification.status, 'running');
    assert.equal(r.proof.sha256, createHash('sha256').update(bytes).digest('hex'));
    await e.verifier!.idle();
    const p = await proofRow(e, f.id); assert.equal(p.size_bytes, bytes.length); assert.ok(p.bytes && p.bytes.length === bytes.length); assert.equal(p.has_image, true);
    const v = await e.svc.verification(e.family, f.id);
    assert.equal(v.status, 'completed'); assert.equal(v.recommendation, 'recommend_approve'); assert.equal(v.score, 1); assert.equal(v.checks.length, 6);
    assert.ok(v.checks.every((c: any) => c.status === 'pass' && c.reason_en && c.reason_es)); assert.equal(v.human_approval_required, true); assert.equal(v.advisory_only, true);
    // NEVER auto-approved: milestone still waits for a human; capture is impossible
    assert.equal(await state(e, f.id), 'proof_submitted');
    const caps = e.fake.captureCalls.length;
    assert.equal(await code(e.svc.approve(e.family, f.id)), '409:conflict');
    assert.equal(e.fake.captureCalls.length, caps);
    const rows = (await e.db.query(`SELECT actor, action, after FROM audit_log WHERE case_id = $1 ORDER BY id`, [f.caseId])).rows;
    const done = rows.find(x => x.action === 'verification.completed'); assert.ok(done); assert.equal(done.after.advisory_only, true); assert.match(done.actor, /^ai_proof_check/);
    assert.equal(rows.find(x => x.action === 'milestone.proof_submitted')!.after.proof_sha256, r.proof.sha256);
    // human verifies + approves -> captured, and the image bytes are deleted (hash kept)
    await e.svc.verifyProof(e.reviewer, f.id, {}); await e.svc.approve(e.family, f.id);
    const after = await proofRow(e, f.id); assert.equal(after.bytes, null); assert.ok(after.bytes_deleted_at); assert.equal(after.sha256, r.proof.sha256);
    assert.ok((await e.svc.verification(e.family, f.id)).proof.bytes_deleted_at);
  });

  test('forged proof: reject recommendation with highlighted failures, still not auto-rejected; human reject deletes bytes', async () => {
    const f = await fundedCase(e); await upload(e, f.id, 'forged_blatant'); await e.verifier!.idle();
    const v = await e.svc.verification(e.provider, f.id);
    assert.equal(v.recommendation, 'recommend_reject'); assert.equal(v.score, 0.25);
    assert.deepEqual(v.explanation.highlighted, ['receipt_format', 'form_type_match', 'notice_date_valid', 'beneficiary_match']);
    assert.equal(await state(e, f.id), 'proof_submitted'); // not auto-rejected either
    await e.svc.reject(e.family, f.id, { reason: 'AI check flagged mismatches (synthetic)' });
    assert.equal((await proofRow(e, f.id)).bytes, null);
  });

  test('subtle forgery and blurry image route to human review with the unsure checks highlighted', async () => {
    const a = await fundedCase(e); await upload(e, a.id, 'forged_subtle'); await e.verifier!.idle();
    const va = await e.svc.verification(e.reviewer, a.id); assert.equal(va.recommendation, 'needs_human_review'); assert.deepEqual(va.explanation.highlighted, ['beneficiary_match']);
    const b = await fundedCase(e); await upload(e, b.id, 'blurry'); await e.verifier!.idle();
    const vb = await e.svc.verification(e.reviewer, b.id); assert.equal(vb.recommendation, 'needs_human_review'); assert.equal(vb.score, 0.5);
  });

  test('milestones without expectations run those checks as not_run (human review)', async () => {
    const c = await e.svc.createCase(e.provider, { title: 'No expectations', milestones: [{ title: 'M', amount: '5.00' }] });
    const id = c.milestones[0].id; await e.svc.openOrder(e.family, id, { payment_source: 'card' });
    await upload(e, id, 'good_receipt_notice'); await e.verifier!.idle();
    const v = await e.svc.verification(e.family, id); assert.equal(v.recommendation, 'needs_human_review');
    assert.deepEqual(v.checks.filter((c: any) => c.status === 'not_run').map((c: any) => c.id).sort(), ['beneficiary_match', 'document_type_match', 'form_type_match']);
  });

  test('upload validation: only PNG/JPEG/WebP, max 5 MB, provider owner only, note or file required', async () => {
    const f = await fundedCase(e);
    assert.equal(await code(e.svc.submitProof(e.provider, f.id, { file_base64: Buffer.from('%PDF-1.4 not an image').toString('base64') })), '415:unsupported_media_type');
    assert.equal(await code(e.svc.submitProof(e.provider, f.id, { file_base64: Buffer.concat([fx('blurry'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64') })), '413:too_large');
    assert.equal(await code(e.svc.submitProof(e.provider, f.id, {})), '400:bad_request');
    assert.equal(await code(e.svc.submitProof(e.provider2, f.id, { file_base64: fx('blurry').toString('base64') })), '403:forbidden');
    assert.equal(await code(e.svc.submitProof(e.family, f.id, { file_base64: fx('blurry').toString('base64') })), '403:forbidden');
    assert.equal(await state(e, f.id), 'authorized'); assert.equal((await e.db.query('SELECT 1 FROM proofs WHERE milestone_id = $1', [f.id])).rowCount, 0);
  });

  test('GET verification: 404 before proof, other providers blocked, double upload is idempotent (one run)', async () => {
    const f = await fundedCase(e);
    assert.equal(await code(e.svc.verification(e.family, f.id)), '404:not_found');
    await upload(e, f.id, 'good_interview_notice'); const again = await upload(e, f.id, 'good_interview_notice'); await e.verifier!.idle();
    assert.equal(again.idempotent, true);
    assert.equal((await e.db.query('SELECT 1 FROM verification_runs WHERE milestone_id = $1', [f.id])).rowCount, 1);
    assert.equal(await code(e.svc.verification(e.provider2, f.id)), '403:forbidden');
  });

  test('note-only proof (no image): run completes with all checks not_run -> human review', async () => {
    const f = await fundedCase(e); await e.svc.submitProof(e.provider, f.id, { note: 'photos sent by mail' }); await e.verifier!.idle();
    const v = await e.svc.verification(e.reviewer, f.id);
    assert.equal(v.recommendation, 'needs_human_review'); assert.ok(v.checks.every((c: any) => c.status === 'not_run')); assert.match(v.error, /no image/);
  });
});

describe('db: AI down or flaky', opts, () => {
  test('AI down: retried ONCE, then all checks not_run and routed to human review', async () => {
    const ext = counting(fixtureExtractor, 99); const e = await setup(ext);
    try {
      const f = await fundedCase(e); await upload(e, f.id, 'good_receipt_notice'); await e.verifier!.idle();
      assert.equal(ext.calls, 2);
      const v = await e.svc.verification(e.family, f.id);
      assert.equal(v.recommendation, 'needs_human_review'); assert.equal(v.attempts, 2); assert.match(v.error, /model unavailable/);
      assert.ok(v.checks.every((c: any) => c.status === 'not_run')); assert.equal(v.extraction, null); assert.equal(v.status, 'completed');
      assert.equal(await state(e, f.id), 'proof_submitted');
    } finally { await e.close(); }
  });
  test('transient failure: retry succeeds on the second attempt', async () => {
    const ext = counting(fixtureExtractor, 1); const e = await setup(ext);
    try {
      const f = await fundedCase(e); await upload(e, f.id, 'good_rfe_response'.replace('rfe_response', 'receipt_notice')); await e.verifier!.idle();
      assert.equal(ext.calls, 2); const v = await e.svc.verification(e.family, f.id); assert.equal(v.attempts, 2); assert.equal(v.recommendation, 'recommend_approve'); assert.equal(v.error, null);
    } finally { await e.close(); }
  });
  test('no provider configured: one attempt (no pointless retry), human review', async () => {
    const e = await setup(noExtractor);
    try {
      const f = await fundedCase(e); await upload(e, f.id, 'good_receipt_notice'); await e.verifier!.idle();
      const v = await e.svc.verification(e.family, f.id); assert.equal(v.attempts, 1); assert.equal(v.recommendation, 'needs_human_review'); assert.match(v.error, /no AI provider/);
    } finally { await e.close(); }
  });
  test('stale running runs are resumed', async () => {
    const e = await setup(fixtureExtractor);
    try {
      const f = await fundedCase(e); await upload(e, f.id, 'good_receipt_notice'); await e.verifier!.idle();
      await e.db.query(`UPDATE verification_runs SET status = 'running', recommendation = NULL, finished_at = NULL, started_at = now() - interval '1 hour' WHERE milestone_id = $1`, [f.id]);
      assert.equal(await e.verifier!.resumeStale(), 1); await e.verifier!.idle();
      assert.equal((await e.svc.verification(e.family, f.id)).status, 'completed');
    } finally { await e.close(); }
  });
});

describe('http: proof upload + verification endpoints', opts, () => {
  test('POST proof (base64 image) then GET verification over HTTP', async () => {
    const { createApp } = await import('../src/app.js'); const { MemoryStore } = await import('../src/store.js'); const { buildApi } = await import('../src/routes.js');
    const e = await setup(fixtureExtractor); const srv = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, e.guarded) }).listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const call = async (u: string | null, m: string, p: string, b?: unknown) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(u ? { 'x-demo-user': u } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: (await r.json()) as any }; };
    try {
      const f = await fundedCase(e);
      assert.equal((await call(null, 'POST', `/api/milestones/${f.id}/proof`, { note: 'x' })).status, 401);
      const up = await call('provider_demo', 'POST', `/api/milestones/${f.id}/proof`, { filename: 'forged_subtle.png', file_base64: fx('forged_subtle').toString('base64') });
      assert.equal(up.status, 200); assert.equal(up.json.verification.status, 'running'); assert.match(up.json.proof.sha256, /^[0-9a-f]{64}$/);
      await e.verifier!.idle();
      const g = await call('family_demo', 'GET', `/api/milestones/${f.id}/verification`);
      assert.equal(g.status, 200); assert.equal(g.json.recommendation, 'needs_human_review'); assert.equal(g.json.checks.length, 6); assert.ok(g.json.explanation.summary_es);
      assert.equal(g.json.extraction.beneficiary_name, 'Marco Reyes');
      assert.equal((await call('provider_two', 'GET', `/api/milestones/${f.id}/verification`)).status, 403);
      assert.equal((await call('provider_demo', 'POST', `/api/milestones/${(await fundedCase(e)).id}/proof`, { file_base64: Buffer.from('nope').toString('base64') })).status, 415);
    } finally { srv.close(); await e.close(); }
  });
});
