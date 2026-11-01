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
}
export interface PaymentRow {
  id: string; milestone_id: string; amount: string; currency: string; paypal_order_id: string | null; approve_url: string | null;
  original_authorization_id: string | null; current_authorization_id: string | null;
  authorized_at: Date | null; reauthorized_at: Date | null; honor_until: Date | null; expires_at: Date | null;
  capture_id: string | null; status: string; attempts: Record<string, number>; reauth_count: number; warned_at: Date | null;
  last_error: string | null; mismatch_flag: boolean; mismatch_note: string | null; webhook_confirmed_at: Date | null;
}

export const actorLabel = (a: Actor) => (a.role === 'system' ? 'system' : `${a.label}(${a.role})`);

export async function loadMilestone(q: Pick<pg.PoolClient, 'query'>, id: string, lock = false): Promise<MilestoneRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'milestone not found');
  const { rows } = await q.query(
    `SELECT m.*, c.currency, p.user_id AS provider_user_id, c.family_user_id
       FROM milestones m JOIN cases c ON c.id = m.case_id JOIN providers p ON p.id = c.provider_id
      WHERE m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'milestone not found');
  return rows[0];
}
export async function loadPayment(q: Pick<pg.PoolClient, 'query'>, milestoneId: string): Promise<PaymentRow | null> {
  const { rows } = await q.query('SELECT * FROM payments WHERE milestone_id = $1', [milestoneId]);
  return rows[0] ?? null;
}

/** The only place milestone state changes. Rejects illegal transitions; writes exactly one audit_log row. */
export async function transition(c: pg.PoolClient, m: MilestoneRow, to: MilestoneState, actor: string, detail: Record<string, unknown> = {},
  sets: Record<string, unknown> = {}): Promise<void> {
  assertTransition(m.state, to);
  const cols = Object.keys(sets);
  const setSql = ['state = $2', 'updated_at = now()', ...cols.map((k, i) => `${k} = $${i + 3}`)].join(', ');
  await c.query(`UPDATE milestones SET ${setSql} WHERE id = $1`, [m.id, to, ...cols.map(k => sets[k])]);
  await audit(c, { actor, action: `milestone.${to}`, targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: { state: m.state }, after: { state: to, ...detail } });
  m.state = to;
}

/** PayPal-wins override used only by webhook reconciliation. Bypasses the state machine on purpose; always audited. */
export async function forceState(c: pg.PoolClient, m: MilestoneRow, to: MilestoneState, actor: string, reason: string): Promise<void> {
  await c.query('UPDATE milestones SET state = $2, updated_at = now() WHERE id = $1', [m.id, to]);
  await audit(c, { actor, action: 'reconcile.override', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: { state: m.state }, after: { state: to, reason } });
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
