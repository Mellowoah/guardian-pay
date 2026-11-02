import type pg from 'pg';
import { audit } from './audit.js';
import { assertTransition, type MilestoneState } from './state.js';
import type { Actor } from './guard.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) { super(message ?? code); this.name = 'HttpError'; }
}

export interface MilestoneRow {
  id: string; case_id: string; seq: number; title: string; amount: string; state: MilestoneState;
  proof_note: string | null; rejection_reason: string | null; currency: string; provider_user_id: number; family_user_id: number | null;
  expected_form_type?: string | null; expected_document_type?: string | null;
  verified_by?: number | null; verified_proof_sha256?: string | null; approved_by?: number | null; disputed_at?: Date | null; dispute_note?: string | null;
  verified_by_name?: string | null; approved_by_name?: string | null; case_clock_offset_days: number;
}
export interface PaymentRow {
  id: string; milestone_id: string; amount: string; currency: string; paypal_order_id: string | null; approve_url: string | null;
  original_authorization_id: string | null; current_authorization_id: string | null;
  authorized_at: Date | null; reauthorized_at: Date | null; honor_until: Date | null; expires_at: Date | null;
  capture_id: string | null; status: string; attempts: Record<string, number>; reauth_count: number; warned_at: Date | null;
  last_error: string | null; mismatch_flag: boolean; mismatch_note: string | null; webhook_confirmed_at: Date | null;
}

/** the case's own (demo) clock: real time shifted by the per-case offset. There is no global clock. */
export const caseNow = (offsetDays: number, real = Date.now()) => new Date(real + (offsetDays || 0) * 86_400_000);
export const mNow = (m: Pick<MilestoneRow, 'case_clock_offset_days'>) => caseNow(m.case_clock_offset_days);

export const actorLabel = (a: Actor) => (a.role === 'system' ? 'system' : `${a.label}(${a.role})`);

export async function loadMilestone(q: Pick<pg.PoolClient, 'query'>, id: string, lock = false): Promise<MilestoneRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'milestone not found');
  const { rows } = await q.query(
    `SELECT m.*, c.currency, p.user_id AS provider_user_id, c.family_user_id, c.clock_offset_days AS case_clock_offset_days,
            (SELECT username FROM users WHERE id = m.verified_by) AS verified_by_name, (SELECT username FROM users WHERE id = m.approved_by) AS approved_by_name
       FROM milestones m JOIN cases c ON c.id = m.case_id JOIN providers p ON p.id = c.provider_id
      WHERE m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'milestone not found');
  return rows[0];
}
export async function loadPayment(q: Pick<pg.PoolClient, 'query'>, milestoneId: string): Promise<PaymentRow | null> {
  const { rows } = await q.query('SELECT * FROM payments WHERE milestone_id = $1', [milestoneId]);
  return rows[0] ?? null;
}

const DECIDED = ['captured', 'rejected', 'voided', 'expired'];
/** Proof image bytes are deleted once a decision is made (the sha256 hash and the audit trail stay). */
export async function purgeProofBytes(c: pg.PoolClient, milestoneId: string): Promise<void> {
  await c.query('UPDATE proofs SET bytes = NULL, bytes_deleted_at = now() WHERE milestone_id = $1 AND bytes IS NOT NULL', [milestoneId]);
}

/** The only place milestone state changes. Rejects illegal transitions; writes exactly one audit_log row. */
export async function transition(c: pg.PoolClient, m: MilestoneRow, to: MilestoneState, actor: string, detail: Record<string, unknown> = {},
  sets: Record<string, unknown> = {}): Promise<void> {
  assertTransition(m.state, to);
  const cols = Object.keys(sets);
  const setSql = ['state = $2', 'updated_at = now()', ...cols.map((k, i) => `${k} = $${i + 3}`)].join(', ');
  await c.query(`UPDATE milestones SET ${setSql} WHERE id = $1`, [m.id, to, ...cols.map(k => sets[k])]);
  await audit(c, { actor, action: `milestone.${to}`, targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: { state: m.state }, after: { state: to, ...detail } });
  if (DECIDED.includes(to)) await purgeProofBytes(c, m.id);
  m.state = to;
}

/** PayPal-wins override used only by webhook reconciliation. Bypasses the state machine on purpose; always audited. */
export async function forceState(c: pg.PoolClient, m: MilestoneRow, to: MilestoneState, actor: string, reason: string): Promise<void> {
  await c.query('UPDATE milestones SET state = $2, updated_at = now() WHERE id = $1', [m.id, to]);
  await audit(c, { actor, action: 'reconcile.override', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: { state: m.state }, after: { state: to, reason } });
  if (DECIDED.includes(to)) await purgeProofBytes(c, m.id);
  m.state = to;
}

export async function updatePayment(c: pg.PoolClient, id: string, sets: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(sets);
  if (!cols.length) return;
  await c.query(`UPDATE payments SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...cols.map(k => (k === 'attempts' ? JSON.stringify(sets[k]) : sets[k]))]);
}

export const attemptOf = (p: PaymentRow | null, action: string) => Math.max(1, Number(p?.attempts?.[action] ?? 1));
export const bumped = (p: PaymentRow, action: string) => ({ ...p.attempts, [action]: attemptOf(p, action) + 1 });
