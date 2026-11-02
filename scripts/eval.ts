/**
 * Eval: runs the 6 synthetic proof fixtures through extraction + the deterministic checks and asserts the expected recommendation.
 *   npm run eval                      -> offline fixture extractor (default)
 *   AI_PROVIDER=gemini AI_API_KEY=... npm run eval   -> real vision extraction (same assertions)
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/verify/checks.js';
import { makeExtractor } from '../src/verify/extraction.js';

const dir = new URL('../test/fixtures/proofs/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const env = { ...process.env, AI_PROVIDER: process.env.AI_PROVIDER || 'fixture' };
const extractor = makeExtractor(env);
const now = new Date(manifest.now);
const pad = (s: string, n: number) => s.padEnd(n);

console.log(`extractor: ${extractor.name}   now: ${manifest.now}\n`);
console.log(`${pad('proof', 24)} ${pad('expected', 20)} ${pad('actual', 20)} ${pad('score', 11)} to-look-at`);
let bad = 0;
for (const f of manifest.fixtures) {
  const bytes = readFileSync(new URL(f.file, dir));
  let ex = null, err = '';
  try { ex = await extractor.extract(bytes, 'image/png'); } catch (e) { err = (e as Error).message; }
  const ctx = { caseCreatedAt: new Date(f.context.case_created_at + 'T00:00:00Z'), now, beneficiaryName: f.context.beneficiary_name,
    expectedFormType: f.context.expected_form_type, expectedDocumentType: f.context.expected_document_type,
    reuse: { sameImage: 0, sameReceipt: 0, hasImage: true } }; // each fixture is evaluated on its own (no earlier use)
  const v = evaluate(ex, ctx);
  const again = evaluate(ex, ctx); // repeatability: same extraction -> same verdict
  const ok = v.recommendation === f.expected_recommendation && v.score === f.expected_score && JSON.stringify(v) === JSON.stringify(again);
  if (!ok) bad++;
  console.log(`${pad(f.file.replace('.png', ''), 24)} ${pad(f.expected_recommendation, 20)} ${pad(v.recommendation, 20)} ${pad(`${v.score.toFixed(2)}/${f.expected_score.toFixed(2)}`, 11)} ${v.highlighted.join(',') || '-'}  ${ok ? 'PASS' : 'FAIL'}${err ? '  (' + err + ')' : ''}`);
}
console.log(`\n${manifest.fixtures.length - bad}/${manifest.fixtures.length} PASS`);
process.exit(bad ? 1 : 0);
