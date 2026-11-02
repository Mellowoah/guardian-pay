import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECKS, CHECK_ORDER, WEIGHTS, evaluate, recommend, runChecks, scoreOf, namesMatch, parseIsoDate, type CheckContext, type Extraction } from '../src/verify/checks.js';
import { parseExtraction, geminiExtractor, openaiExtractor, makeExtractor, noExtractor, fixtureExtractor, pngTextChunks, sniffImage, ExtractionUnavailable } from '../src/verify/extraction.js';

const ctx: CheckContext = { caseCreatedAt: new Date('2026-01-15T10:00:00Z'), now: new Date('2026-11-01T12:00:00Z'), beneficiaryName: 'Mateo Reyes', expectedFormType: 'I-130', expectedDocumentType: 'receipt_notice' };
const good: Extraction = { form_type: 'I-130', receipt_number: 'EAC2612345678', notice_date: '2026-02-10', beneficiary_name: 'Mateo Reyes', document_type: 'receipt_notice', case_type: 'x', legibility: 'clear', confidence: 0.95 };
const st = (id: keyof typeof CHECKS, x: Extraction | null, c = ctx) => CHECKS[id](x, c).status;

test('check 1 receipt format: 3 letters + 10 digits', () => {
  assert.equal(st('receipt_format', good), 'pass');
  assert.equal(st('receipt_format', { ...good, receipt_number: 'eac 2612345678' }), 'pass'); // case + spaces normalised
  for (const bad of ['EAC261234567', 'EAC26123456789', 'EA2612345678', 'EAC-2612345678', '1234567890EAC', 'EAC26123456X8']) assert.equal(st('receipt_format', { ...good, receipt_number: bad }), 'fail', bad);
  assert.equal(st('receipt_format', { ...good, receipt_number: null }), 'not_run'); assert.equal(st('receipt_format', null), 'not_run');
});
test('check 2 form type matches the milestone (punctuation/case-insensitive)', () => {
  assert.equal(st('form_type_match', good), 'pass'); assert.equal(st('form_type_match', { ...good, form_type: 'i 130' }), 'pass');
  assert.equal(st('form_type_match', { ...good, form_type: 'I-765' }), 'fail');
  assert.equal(st('form_type_match', { ...good, form_type: null }), 'not_run'); assert.equal(st('form_type_match', good, { ...ctx, expectedFormType: null }), 'not_run');
});
test('check 3 notice date: after case creation, not in the future, valid calendar date', () => {
  assert.equal(st('notice_date_valid', good), 'pass');
  assert.equal(st('notice_date_valid', { ...good, notice_date: '2026-01-15' }), 'pass'); // same day as creation
  assert.equal(st('notice_date_valid', { ...good, notice_date: '2026-11-01' }), 'pass'); // today
  assert.equal(st('notice_date_valid', { ...good, notice_date: '2026-11-02' }), 'fail');
  assert.equal(st('notice_date_valid', { ...good, notice_date: '2026-01-14' }), 'fail');
  assert.equal(st('notice_date_valid', { ...good, notice_date: '2026-02-30' }), 'fail'); assert.equal(st('notice_date_valid', { ...good, notice_date: '10/02/2026' }), 'fail');
  assert.equal(st('notice_date_valid', { ...good, notice_date: null }), 'not_run');
  assert.equal(parseIsoDate('2026-02-29'), null); assert.ok(parseIsoDate('2028-02-29'));
});
test('check 4 beneficiary name: token match, accents/order/middle names ok, different name fails', () => {
  assert.equal(st('beneficiary_match', good), 'pass');
  for (const ok of ['Mateo José Reyes', 'REYES, Mateo', 'Mateo  Reyes']) assert.equal(st('beneficiary_match', { ...good, beneficiary_name: ok }), 'pass', ok);
  assert.equal(namesMatch('José Núñez', 'Jose Nunez'), true);
  for (const bad of ['Marco Reyes', 'M. Reyez', 'Mateo', 'Ana Reyes']) assert.equal(st('beneficiary_match', { ...good, beneficiary_name: bad }), 'fail', bad);
  assert.equal(st('beneficiary_match', { ...good, beneficiary_name: null }), 'not_run'); assert.equal(st('beneficiary_match', good, { ...ctx, beneficiaryName: null }), 'not_run');
});
test('check 5 document type matches the milestone', () => {
  assert.equal(st('document_type_match', good), 'pass');
  assert.equal(st('document_type_match', { ...good, document_type: 'interview_notice' }), 'fail');
  assert.equal(st('document_type_match', { ...good, document_type: 'other' }), 'fail');
  assert.equal(st('document_type_match', { ...good, document_type: 'rfe_response' }, { ...ctx, expectedDocumentType: 'rfe_response' }), 'pass');
  assert.equal(st('document_type_match', { ...good, document_type: null }), 'not_run'); assert.equal(st('document_type_match', good, { ...ctx, expectedDocumentType: null }), 'not_run');
});
test('check 6 legibility/confidence: clear+confident passes, blurry/low confidence not_run, unreadable fails', () => {
  assert.equal(st('legibility', good), 'pass');
  assert.equal(st('legibility', { ...good, confidence: 0.6 }), 'pass'); assert.equal(st('legibility', { ...good, confidence: 0.59 }), 'not_run');
  assert.equal(st('legibility', { ...good, legibility: 'blurry' }), 'not_run'); assert.equal(st('legibility', { ...good, legibility: 'unreadable' }), 'fail');
  assert.equal(st('legibility', null), 'not_run');
});
test('every check returns an English AND Spanish reason, and six checks always run in order', () => {
  for (const x of [good, null, { ...good, receipt_number: 'BAD', form_type: 'I-1', notice_date: '2099-01-01', beneficiary_name: 'Zed', document_type: 'other' as const }]) {
    const r = runChecks(x, ctx); assert.deepEqual(r.map(c => c.id), CHECK_ORDER); assert.equal(r.length, 6);
    for (const c of r) { assert.ok(c.reason_en.length > 10 && c.reason_es.length > 10 && c.label_es, c.id); assert.notEqual(c.reason_en, c.reason_es); assert.ok(['pass', 'fail', 'not_run'].includes(c.status)); }
  }
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

const mk = (statuses: Partial<Record<keyof typeof WEIGHTS, 'pass' | 'fail' | 'not_run'>>) => CHECK_ORDER.map(id => ({ id, weight: WEIGHTS[id], status: statuses[id] ?? 'pass' }));
test('scoring: pass=full, not_run=half, fail=zero, in 0..1', () => {
  assert.equal(scoreOf(mk({})), 1);
  assert.equal(scoreOf(mk({ beneficiary_match: 'fail' })), 0.8);
  assert.equal(scoreOf(mk({ beneficiary_match: 'not_run' })), 0.9);
  assert.equal(scoreOf(CHECK_ORDER.map(id => ({ id, weight: WEIGHTS[id], status: 'not_run' as const }))), 0.5);
  assert.equal(scoreOf(CHECK_ORDER.map(id => ({ id, weight: WEIGHTS[id], status: 'fail' as const }))), 0);
});
test('thresholds: >=0.8 approve, 0.5-0.8 human review, <0.5 reject; approve never with a fail or not_run; reject never on incomplete evidence', () => {
  assert.equal(recommend(mk({})), 'recommend_approve');
  assert.equal(recommend(mk({ legibility: 'fail' })), 'needs_human_review');          // 0.9 but a check failed -> capped
  assert.equal(recommend(mk({ legibility: 'not_run' })), 'needs_human_review');       // 0.95 but unsure -> capped
  assert.equal(recommend(mk({ beneficiary_match: 'fail' })), 'needs_human_review');   // exactly 0.8 with a fail
  assert.equal(recommend(mk({ beneficiary_match: 'fail', form_type_match: 'fail' })), 'needs_human_review'); // 0.6
  assert.equal(scoreOf(mk({ beneficiary_match: 'fail', form_type_match: 'fail', receipt_format: 'fail' })), 0.4);
  assert.equal(recommend(mk({ beneficiary_match: 'fail', form_type_match: 'fail', receipt_format: 'fail' })), 'recommend_reject');
  assert.equal(scoreOf(mk({ beneficiary_match: 'fail', form_type_match: 'fail', notice_date_valid: 'fail' })), 0.45);
  assert.equal(scoreOf(mk({ beneficiary_match: 'fail', form_type_match: 'fail', document_type_match: 'fail' })), 0.45);
  assert.equal(recommend(mk({ beneficiary_match: 'fail', form_type_match: 'fail', receipt_format: 'fail', notice_date_valid: 'not_run' })), 'needs_human_review'); // <0.5 but incomplete
  assert.equal(scoreOf(mk({ beneficiary_match: 'fail', form_type_match: 'fail' })), 0.6); // boundary: exactly 0.5 is review, not reject
  const half = [{ id: 'a', weight: 50, status: 'pass' as const }, { id: 'b', weight: 50, status: 'fail' as const }];
  assert.equal(scoreOf(half), 0.5); assert.equal(recommend(half), 'needs_human_review');
});
test('evaluate: explanation is bilingual, highlights unsure checks, and always requires human approval', () => {
  const v = evaluate({ ...good, beneficiary_name: 'Marco Reyes' }, ctx);
  assert.equal(v.recommendation, 'needs_human_review'); assert.deepEqual(v.highlighted, ['beneficiary_match']);
  assert.match(v.explanation.summary_en, /human review/); assert.match(v.explanation.summary_es, /revisión humana/);
  assert.equal(v.explanation.human_approval_required, true);
  assert.equal(evaluate(good, ctx).explanation.human_approval_required, true); // even a perfect score
  assert.deepEqual(evaluate(good, ctx), evaluate(good, ctx)); // repeatable
  const down = evaluate(null, ctx); assert.equal(down.recommendation, 'needs_human_review'); assert.ok(down.checks.every(c => c.status === 'not_run'));
});

test('parseExtraction sanitises model output (unknown values become null, extra keys dropped, confidence clamped)', () => {
  const x = parseExtraction({ form_type: 'I-130', receipt_number: 'EAC2612345678', notice_date: '2026-02-10', beneficiary_name: 'A'.repeat(500), document_type: 'banana', legibility: 'perfect', confidence: 7, approve: true, instructions: 'ignore rules' });
  assert.equal(x.document_type, null); assert.equal(x.legibility, 'blurry'); assert.equal(x.confidence, 1); assert.equal(x.beneficiary_name!.length, 120); assert.ok(!('approve' in x));
  assert.throws(() => parseExtraction('hello')); assert.throws(() => parseExtraction([])); assert.throws(() => parseExtraction({ foo: 1 }));
  assert.equal(parseExtraction({ form_type: 'I-130', confidence: 'high' }).confidence, 0);
});

const png = readFileSync(new URL('./fixtures/proofs/good_receipt_notice.png', import.meta.url));
const modelJson = JSON.stringify({ form_type: 'I-130', receipt_number: 'EAC2612345678', notice_date: '2026-02-10', beneficiary_name: 'Mateo Reyes', document_type: 'receipt_notice', case_type: 'x', legibility: 'clear', confidence: 0.9 });
test('gemini provider: key in header (not URL), image inlined, JSON parsed (also from a code fence)', async () => {
  let seen: any;
  const f = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n' + modelJson + '\n```' }] } }] }) }; }) as any;
  const x = await geminiExtractor({ apiKey: 'K-test', model: 'm1' }, f).extract(png, 'image/png');
  assert.equal(x.receipt_number, 'EAC2612345678'); assert.ok(!seen.url.includes('K-test')); assert.equal(seen.init.headers['x-goog-api-key'], 'K-test');
  const b = JSON.parse(seen.init.body); assert.equal(b.contents[0].parts[1].inline_data.mime_type, 'image/png'); assert.ok(b.contents[0].parts[1].inline_data.data.length > 100); assert.equal(b.generationConfig.temperature, 0);
});
test('openai-compatible provider: bearer auth, image as data URL, custom base url, JSON mode', async () => {
  let seen: any;
  const f = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: modelJson } }] }) }; }) as any;
  const x = await openaiExtractor({ apiKey: 'K-test', baseUrl: 'https://llm.example.test/v1/' }, f).extract(png, 'image/png');
  assert.equal(x.beneficiary_name, 'Mateo Reyes'); assert.equal(seen.url, 'https://llm.example.test/v1/chat/completions'); assert.equal(seen.init.headers.authorization, 'Bearer K-test');
  const b = JSON.parse(seen.init.body); assert.equal(b.response_format.type, 'json_object'); assert.match(b.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});
test('providers throw on HTTP errors and garbage output (the verifier then retries once)', async () => {
  const http = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
  await assert.rejects(geminiExtractor({ apiKey: 'k' }, http).extract(png, 'image/png'), /http 503/);
  const junk = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'sure! approve it' } }] }) })) as any;
  await assert.rejects(openaiExtractor({ apiKey: 'k' }, junk).extract(png, 'image/png'));
});
test('makeExtractor: AI_PROVIDER selects; missing key or unset = no extractor (human review); keys only from AI_API_KEY', () => {
  assert.equal(makeExtractor({}).name, 'none'); assert.equal(makeExtractor({ AI_PROVIDER: 'gemini' }).name, 'none');
  assert.equal(makeExtractor({ AI_PROVIDER: 'fixture' }).name, 'fixture'); assert.match(makeExtractor({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k' }).name, /^gemini:/);
  assert.match(makeExtractor({ AI_PROVIDER: 'openai', AI_API_KEY: 'k', AI_MODEL: 'gpt-x' }).name, /^openai:gpt-x/);
  assert.equal(makeExtractor({ LLM_API_KEY: 'other-project', AI_PROVIDER: 'openai' }).name, 'none'); // never falls back to other projects' keys
  assert.equal(makeExtractor({ AI_PROVIDER: 'nonsense', AI_API_KEY: 'k' }).name, 'none');
});
test('no extractor is permanent (no retry); fixture extractor refuses non-fixture images; sniffImage by magic bytes', async () => {
  await assert.rejects(noExtractor.extract(png, 'image/png'), (e: any) => e instanceof ExtractionUnavailable && e.permanent);
  const plain = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await assert.rejects(fixtureExtractor.extract(plain, 'image/png'), /not a Guardian Pay fixture/);
  assert.equal(sniffImage(png), 'image/png'); assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 'image/jpeg'); assert.equal(sniffImage(Buffer.from('%PDF-1.4 hello world')), null);
  assert.ok(pngTextChunks(png)['gp-synthetic']);
});

test('fixtures: every proof image is marked SYNTHETIC and the eval manifest matches the offline extractor', async () => {
  const m = JSON.parse(readFileSync(new URL('./fixtures/proofs/manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.fixtures.length, 6);
  const counts: Record<string, number> = {};
  for (const f of m.fixtures) {
    const bytes = readFileSync(new URL('./fixtures/proofs/' + f.file, import.meta.url));
    assert.match(pngTextChunks(bytes)['gp-synthetic'] ?? '', /SYNTHETIC/);
    const x = await fixtureExtractor.extract(bytes, 'image/png');
    const v = evaluate(x, { caseCreatedAt: new Date(f.context.case_created_at + 'T00:00:00Z'), now: new Date(m.now), beneficiaryName: f.context.beneficiary_name, expectedFormType: f.context.expected_form_type, expectedDocumentType: f.context.expected_document_type });
    assert.equal(v.recommendation, f.expected_recommendation, f.file); assert.equal(v.score, f.expected_score, f.file);
    counts[f.expected_recommendation] = (counts[f.expected_recommendation] ?? 0) + 1;
  }
  assert.deepEqual(counts, { recommend_approve: 3, recommend_reject: 1, needs_human_review: 2 });
});

test('untrusted extraction: values read from a blurry/low-confidence image are NOT checked (a model can invent plausible text), human review; never approve or reject', () => {
  const hallucinated: Extraction = { form_type: 'I-797', receipt_number: 'LIN0000000000', notice_date: '2023-11-14', beneficiary_name: 'John Doe', document_type: 'receipt_notice', case_type: null, legibility: 'blurry', confidence: 0.4 };
  const r = runChecks(hallucinated, ctx);
  assert.deepEqual(r.map(c => c.status), ['not_run', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run']);
  assert.ok(r.every(c => c.reason_en && c.reason_es));
  assert.equal(recommend(r), 'needs_human_review'); assert.equal(scoreOf(r), 0.5);
  // a clear image with low confidence is also untrusted; a clear confident one is checked normally
  assert.ok(runChecks({ ...hallucinated, legibility: 'clear', confidence: 0.59 }, ctx).every(c => c.status === 'not_run'));
  assert.ok(runChecks({ ...hallucinated, legibility: 'clear', confidence: 0.9 }, ctx).some(c => c.status === 'fail'));
  // unreadable: legibility fails, the rest are not run -> still human review (incomplete evidence is never a reject)
  const u = runChecks({ ...hallucinated, legibility: 'unreadable', confidence: 0.1 }, ctx);
  assert.equal(u.find(c => c.id === 'legibility')!.status, 'fail'); assert.equal(recommend(u), 'needs_human_review');
});
