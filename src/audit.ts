import type pg from 'pg';

export interface AuditEntry {
  actor: string; action: string; targetType: string; targetId: string; caseId?: string | null;
  before: unknown; after: unknown;
}
/** Append-only (DB trigger blocks UPDATE/DELETE/TRUNCATE). One row per call. */
export async function audit(c: pg.PoolClient | pg.Pool, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (actor, action, target_type, target_id, case_id, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actor, e.action, e.targetType, e.targetId, e.caseId ?? null, JSON.stringify(e.before ?? null), JSON.stringify(e.after ?? null)]);
}
