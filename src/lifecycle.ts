import type { Db } from './db.js';
import { GuardedPayPal, type Actor } from './guard.js';
import { clock, addDays, DAY } from './clock.js';
import { audit } from './audit.js';
import { isDefinitiveFailure, paypalIssue } from './paypal.js';
import { HOLDING, type MilestoneState } from './state.js';
import { loadMilestone, loadPayment, transition, updatePayment, attemptOf, bumped } from './repo.js';

export type LifecycleAction = 'reauthorize' | 'warn' | 'expire';
export interface LifecycleInput {
  now: Date; authorized_at: Date; honor_until: Date; expires_at: Date; reauth_count: number; warned_at: Date | null; state: MilestoneState;
}
export const WARN_DAY = 25;

/** Pure planning step (unit-tested): what should happen to this authorization right now? */
export function planLifecycle(i: LifecycleInput): LifecycleAction[] {
  if (!HOLDING.includes(i.state)) return [];
  const t = i.now.getTime();
  if (t >= i.expires_at.getTime()) return ['expire'];
  const out: LifecycleAction[] = [];
  if (!i.warned_at && t >= i.authorized_at.getTime() + WARN_DAY * DAY) out.push('warn');
  // reauthorize ONCE, after the original 3-day honor period (PayPal: REAUTHORIZATION_TOO_SOON before that)
  if (i.reauth_count === 0 && t >= i.authorized_at.getTime() + 3 * DAY) out.push('reauthorize');
  return out;
}

const SYSTEM: Actor = { userId: null, role: 'system', label: 'system' };
export interface TickResult { checked: number; reauthorized: number; deferred: number; warned: number; expired: number; errors: string[] }

export async function lifecycleTick(db: Db, guarded: GuardedPayPal, opts: { caseId?: string } = {}): Promise<TickResult> {
  const now = clock.now();
  const r: TickResult = { checked: 0, reauthorized: 0, deferred: 0, warned: 0, expired: 0, errors: [] };
  const { rows } = await db.query(
    `SELECT p.milestone_id FROM payments p JOIN milestones m ON m.id = p.milestone_id
      WHERE p.status IN ('authorized','reauthorized') AND m.state = ANY($1) ${opts.caseId ? 'AND m.case_id = $2' : ''}`,
    opts.caseId ? [HOLDING, opts.caseId] : [HOLDING]);
  for (const { milestone_id } of rows) {
    r.checked++;
    try {
      const plan = await db.tx(async c => {
        const m = await loadMilestone(c, milestone_id, true); const p = await loadPayment(c, milestone_id);
        if (!p || !p.authorized_at || !p.expires_at || !p.honor_until) return { actions: [] as LifecycleAction[] };
        return { actions: planLifecycle({ now, authorized_at: p.authorized_at, honor_until: p.honor_until, expires_at: p.expires_at, reauth_count: p.reauth_count, warned_at: p.warned_at, state: m.state }) };
      }, milestone_id);
      for (const a of plan.actions) {
        if (a === 'expire') { await expire(db, milestone_id, now); r.expired++; }
        if (a === 'warn') { await warn(db, milestone_id, now); r.warned++; }
        if (a === 'reauthorize') { const o = await reauth(db, guarded, milestone_id, now); if (o === 'done') r.reauthorized++; else if (o === 'deferred') r.deferred++; }
      }
    } catch (e) { r.errors.push(`${milestone_id}: ${(e as Error).message}`); console.error('lifecycle error', milestone_id, (e as Error).message); }
  }
  return r;
}

async function expire(db: Db, id: string, now: Date) {
  await db.tx(async c => {
    const m = await loadMilestone(c, id, true); const p = (await loadPayment(c, id))!;
    if (!HOLDING.includes(m.state)) return;
    await updatePayment(c, p.id, { status: 'expired' });
    // No PayPal call: the authorization lapses on its own at day 29 (PayPal sends PAYMENT.AUTHORIZATION.VOIDED).
    await transition(c, m, 'expired', 'system', { authorization_id: p.current_authorization_id, expires_at: p.expires_at, at: now.toISOString() });
  }, id);
}

async function warn(db: Db, id: string, now: Date) {
  await db.tx(async c => {
    const m = await loadMilestone(c, id, true); const p = (await loadPayment(c, id))!;
    if (p.warned_at) return;
    await updatePayment(c, p.id, { warned_at: now });
    await audit(c, { actor: 'system', action: 'payment.expiry_warning', targetType: 'payment', targetId: p.id, caseId: m.case_id,
      before: { warned_at: null }, after: { warned_at: now.toISOString(), expires_at: p.expires_at, state: m.state } });
  }, id);
}

async function reauth(db: Db, guarded: GuardedPayPal, id: string, now: Date): Promise<'done' | 'deferred' | 'skipped' | 'failed'> {
  const pre = await db.tx(async c => {
    const m = await loadMilestone(c, id, true); const p = (await loadPayment(c, id))!;
    if (p.reauth_count > 0 || !HOLDING.includes(m.state)) return null;
    const next = Number((p.attempts as any).reauthorize_next_try ?? 0);
    if (Date.now() < next) return null; // backing off after a failed attempt (real time)
    return { m, p };
  }, id);
  if (!pre) return 'skipped';
  const { m, p } = pre;
  const res = await guarded.reauthorize({ actor: SYSTEM, milestone: { id, state: m.state, providerUserId: m.provider_user_id }, amount: p.amount, attempt: attemptOf(p, 'reauthorize') },
    p.current_authorization_id!, p.currency);
  if (res.status >= 300 || !res.body?.id) {
    const issue = paypalIssue(res.body); const tooSoon = issue === 'REAUTHORIZATION_TOO_SOON';
    await db.tx(async c => {
      const p2 = (await loadPayment(c, id))!; const mm = await loadMilestone(c, id, true);
      const attempts: Record<string, number> = isDefinitiveFailure(res.status) ? bumped(p2, 'reauthorize') : { ...p2.attempts };
      const first = !(attempts as any).reauthorize_logged;
      (attempts as any).reauthorize_next_try = Date.now() + (tooSoon ? 3_600_000 : 6 * 3_600_000);
      (attempts as any).reauthorize_logged = 1;
      await updatePayment(c, p2.id, { attempts, last_error: `reauthorize: ${res.status} ${issue}` });
      if (first) await audit(c, { actor: 'system', action: tooSoon ? 'payment.reauthorize_deferred' : 'payment.reauthorize_failed', targetType: 'payment', targetId: p2.id, caseId: mm.case_id,
        before: { current_authorization_id: p2.current_authorization_id }, after: { paypal_status: res.status, paypal_issue: issue, will_retry: true } });
    }, id);
    return tooSoon ? 'deferred' : 'failed';
  }
  const newId: string = res.body.id;
  await db.tx(async c => {
    const m2 = await loadMilestone(c, id, true); const p2 = (await loadPayment(c, id))!;
    if (p2.reauth_count > 0) return;
    const honor = new Date(Math.min(addDays(now, 3).getTime(), p2.expires_at!.getTime()));
    await updatePayment(c, p2.id, { current_authorization_id: newId, reauthorized_at: now, reauth_count: 1, honor_until: honor, status: 'reauthorized', last_error: null });
    const detail = { original_authorization_id: p2.original_authorization_id, previous_authorization_id: p2.current_authorization_id, new_authorization_id: newId, honor_until: honor.toISOString() };
    if (m2.state === 'authorized') await transition(c, m2, 'reauthorized', 'system', detail);
    else await audit(c, { actor: 'system', action: 'payment.reauthorize', targetType: 'payment', targetId: p2.id, caseId: m2.case_id, before: { current_authorization_id: p2.current_authorization_id, state: m2.state }, after: detail });
  }, id);
  return 'done';
}
