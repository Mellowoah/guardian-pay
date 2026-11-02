import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { evaluate, runChecks, scoreOf, recommend, untrustedExtraction, normReceipt, type Extraction } from './checks.js';
import type { Extractor } from './extraction.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clip = (s: string) => s.replace(/\s+/g, ' ').slice(0, 300);

/** Runs the AI proof check in the background. The recommendation is advisory only: this class never changes milestone state. */
export class Verifier {
  private inflight = new Set<Promise<void>>();
  constructor(private db: Db, private extractor: Extractor, private opts: { retryDelayMs: number } = { retryDelayMs: 750 }) {}
  get provider() { return this.extractor.name; }

  start(runId: string) {
    const p: Promise<void> = this.run(runId).catch(e => console.error('verification run failed', runId, (e as Error).message)).finally(() => { this.inflight.delete(p); });
    this.inflight.add(p);
  }
  async idle() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  async run(runId: string): Promise<void> {
    const row = (await this.db.query(
      `SELECT r.status, r.milestone_id, r.proof_id, p.sha256, p.bytes, p.has_image, p.content_type, m.case_id, m.expected_form_type, m.expected_document_type,
              c.created_at AS case_created_at, c.beneficiary_name, c.clock_offset_days
         FROM verification_runs r JOIN proofs p ON p.id = r.proof_id JOIN milestones m ON m.id = r.milestone_id JOIN cases c ON c.id = m.case_id WHERE r.id = $1`, [runId])).rows[0];
    if (!row || row.status !== 'running') return;

    let extraction: Extraction | null = null; let error: string | null = null; let attempts = 0;
    if (!row.bytes) error = row.has_image ? 'proof image was already deleted' : 'no image was uploaded with this proof';
    else {
      for (let i = 0; i < 2 && !extraction; i++) { // retry once
        attempts++;
        try { extraction = await this.extractor.extract(row.bytes as Buffer, row.content_type); error = null; }
        catch (e) { error = clip((e as Error).message); if ((e as any).permanent) break; if (i === 0) await sleep(this.opts.retryDelayMs); }
      }
    }
    // cross-case reuse: same image bytes, or (when the model read one) the same receipt number, on ANY other milestone
    const receipt = extraction && !untrustedExtraction(extraction) && extraction.receipt_number ? normReceipt(extraction.receipt_number) : null;
    const reuse = await this.reuseFor(row.milestone_id, row.proof_id, row.sha256, receipt, !!row.has_image);
    const v = evaluate(extraction, { caseCreatedAt: row.case_created_at, now: new Date(Date.now() + (row.clock_offset_days || 0) * 86_400_000), beneficiaryName: row.beneficiary_name,
      expectedFormType: row.expected_form_type, expectedDocumentType: row.expected_document_type, reuse });
    await this.db.tx(async c => {
      const r = await c.query(
        `UPDATE verification_runs SET status='completed', provider=$2, attempts=$3, extraction=$4, checks=$5, score=$6, recommendation=$7, explanation=$8, error=$9, finished_at=now()
          WHERE id=$1 AND status='running'`,
        [runId, this.extractor.name, attempts, extraction ? JSON.stringify(extraction) : null, JSON.stringify(v.checks), v.score, v.recommendation, JSON.stringify(v.explanation), error]);
      if (!r.rowCount) return;
      await audit(c, { actor: `ai_proof_check(${this.extractor.name})`, action: 'verification.completed', targetType: 'milestone', targetId: row.milestone_id, caseId: row.case_id,
        before: null, after: { run_id: runId, recommendation: v.recommendation, score: v.score, highlighted: v.highlighted, extraction_ok: !!extraction, attempts, reuse: { same_image: reuse.sameImage, same_receipt: reuse.sameReceipt }, advisory_only: true } });
    });
  }

  private async reuseFor(milestoneId: string, proofId: string, sha: string, receipt: string | null, hasImage: boolean) {
    if (!hasImage) return { sameImage: 0, sameReceipt: 0, hasImage };
    const q = await this.db.query(
      `SELECT count(*) FILTER (WHERE sha256 = $2)::int AS same_image, count(*) FILTER (WHERE $3::text IS NOT NULL AND receipt_number = $3)::int AS same_receipt
         FROM proof_registry WHERE milestone_id <> $1`, [milestoneId, sha, receipt]);
    if (receipt) await this.db.query('UPDATE proof_registry SET receipt_number = $2 WHERE proof_id = $1', [proofId, receipt]);
    return { sameImage: q.rows[0].same_image, sameReceipt: q.rows[0].same_receipt, hasImage };
  }

  /** a run can be left 'running' if the process restarted mid-extraction: re-run those */
  async resumeStale(minAgeMs = 5 * 60_000): Promise<number> {
    const { rows } = await this.db.query(`SELECT id FROM verification_runs WHERE status = 'running' AND started_at < now() - ($1 || ' milliseconds')::interval`, [String(minAgeMs)]);
    for (const r of rows) this.start(r.id);
    return rows.length;
  }

  async latest(milestoneId: string) {
    const r = (await this.db.query(
      `SELECT r.id, r.status, r.provider, r.attempts, r.extraction, r.checks, r.score, r.recommendation, r.explanation, r.error, r.started_at, r.finished_at,
              p.sha256, p.size_bytes, p.filename, p.has_image, p.bytes_deleted_at
         FROM verification_runs r JOIN proofs p ON p.id = r.proof_id WHERE r.milestone_id = $1 ORDER BY r.started_at DESC LIMIT 1`, [milestoneId])).rows[0];
    if (!r) return null;
    return { run_id: r.id, status: r.status, provider: r.provider, attempts: r.attempts, score: r.score === null ? null : Number(r.score), recommendation: r.recommendation,
      checks: r.checks, explanation: r.explanation, extraction: r.extraction, error: r.error, started_at: r.started_at, finished_at: r.finished_at,
      advisory_only: true, human_approval_required: true,
      proof: { sha256: r.sha256, size_bytes: r.size_bytes, filename: r.filename, has_image: r.has_image, bytes_deleted_at: r.bytes_deleted_at } };
  }
}
export { runChecks, scoreOf, recommend };
