import type pg from 'pg';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { HOLDING } from './state.js';
import { loadMilestone, loadPayment, transition, forceState, updatePayment, type MilestoneRow, type PaymentRow } from './repo.js';

export const RECONCILED_TYPES = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.AUTHORIZATION.VOIDED'];
const UNMATCHED_GRACE_MS = 10 * 60_000;

export interface ReconcileResult { event_id: string; outcome: 'applied' | 'confirmed' | 'mismatch' | 'ignored' | 'unmatched' | 'skipped'; note: string }

/** Pure: decide what a webhook means given our current state. PayPal wins on any disagreement. */
export type Verdict =
  | { kind: 'confirm'; note: string }
  | { kind: 'apply'; to: 'captured' | 'voided'; note: string }                       // normal, state-machine-legal
  | { kind: 'override'; to: MilestoneRow['state']; payment: string; note: string }   // PayPal wins, flagged
  | { kind: 'flag'; payment?: string; note: string }                                 // no state change, flagged
  | { kind: 'ignore'; note: string };

export function decide(type: string, rid: string, m: Pick<MilestoneRow, 'state'>, p: Pick<PaymentRow, 'capture_id' | 'original_authorization_id' | 'current_authorization_id' | 'reauth_count' | 'expires_at' | 'status'>,
  hasApproval: boolean, now: Date): Verdict {
  switch (type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      if (m.state === 'captured' && p.capture_id === rid) return { kind: 'confirm', note: 'capture confirmed by PayPal webhook' };
      if (m.state === 'verified' && hasApproval) return { kind: 'apply', to: 'captured', note: 'capture completed (webhook arrived before API response)' };
      if (m.state === 'captured') return { kind: 'override', to: 'captured', payment: 'captured', note: `capture id mismatch: ours ${p.capture_id}, PayPal ${rid}` };
      return { kind: 'override', to: 'captured', payment: 'captured', note: `PayPal reports capture ${rid} completed but milestone was ${m.state}${hasApproval ? '' : ' with NO recorded human approval'}` };
    }
    case 'PAYMENT.CAPTURE.DECLINED': case 'PAYMENT.CAPTURE.DENIED': {
      const what = type.endsWith('DECLINED') ? 'declined' : 'denied';
      if (m.state === 'captured') return { kind: 'override', to: 'verified', payment: 'capture_failed', note: `PayPal says capture ${rid} was ${what}; we had recorded it captured` };
      if (m.state === 'verified') return { kind: 'flag', payment: 'capture_failed', note: `capture ${rid} ${what} by PayPal; milestone stays verified, can be re-approved` };
      return { kind: 'ignore', note: `capture ${rid} ${what}; milestone is ${m.state}, nothing to undo` };
    }
    case 'PAYMENT.AUTHORIZATION.VOIDED': {
      if (p.reauth_count > 0 && rid === p.original_authorization_id && rid !== p.current_authorization_id) return { kind: 'ignore', note: 'original authorization superseded by reauthorization' };
      if (m.state === 'voided' || m.state === 'expired') return { kind: 'confirm', note: `void confirmed by PayPal webhook (milestone ${m.state})` };
      if (m.state === 'rejected') return { kind: 'apply', to: 'voided', note: 'void confirmed (webhook arrived before API response)' };
      if (HOLDING.includes(m.state)) {
        const lapsed = p.expires_at && now.getTime() >= p.expires_at.getTime();
        return { kind: 'override', to: lapsed ? 'expired' : 'voided', payment: lapsed ? 'expired' : 'voided', note: `authorization ${rid} voided at PayPal while milestone was ${m.state}` };
      }
      return { kind: 'flag', note: `authorization ${rid} voided at PayPal after milestone reached ${m.state}` };
    }
  }
  return { kind: 'ignore', note: `unhandled type ${type}` };
}

const matchSql = `SELECT milestone_id FROM payments WHERE capture_id = $1 OR current_authorization_id = $2 OR original_authorization_id = $2
                  OR paypal_order_id = $3 OR milestone_id::text = $4 LIMIT 1`;

export async function reconcileEvent(db: Db, eventId: string, now = new Date()): Promise<ReconcileResult> {
  const ev = (await db.query('SELECT paypal_event_id, event_type, verified, payload, received_at, processed_at FROM webhook_events WHERE paypal_event_id = $1', [eventId])).rows[0];
  if (!ev) return { event_id: eventId, outcome: 'skipped', note: 'unknown event' };
  if (ev.processed_at) return { event_id: eventId, outcome: 'skipped', note: 'already processed' };
  const done = async (c: { query: (t: string, p?: any[]) => Promise<unknown> }, note: string) => { await c.query('UPDATE webhook_events SET processed_at = now(), reconcile_note = $2 WHERE paypal_event_id = $1', [eventId, note]); };
  if (!ev.verified || !RECONCILED_TYPES.includes(ev.event_type)) { await done(db, ev.verified ? 'type not reconciled' : 'unverified'); return { event_id: eventId, outcome: 'ignored', note: 'not reconciled' }; }

  const r = ev.payload?.resource ?? {};
  const rid: string = String(r.id ?? '');
  const related = r.supplementary_data?.related_ids ?? {};
  const authId: string = String(related.authorization_id ?? (ev.event_type === 'PAYMENT.AUTHORIZATION.VOIDED' ? rid : ''));
  const orderId = String(related.order_id ?? '');
  const custom = /^[0-9a-f-]{36}$/i.test(String(r.custom_id ?? '')) ? String(r.custom_id) : '00000000-0000-0000-0000-000000000000';
  const hit = (await db.query(matchSql, [rid, authId || '-', orderId || '-', custom])).rows[0];
  if (!hit) {
    if (now.getTime() - new Date(ev.received_at).getTime() > UNMATCHED_GRACE_MS) await done(db, 'no matching payment');
    return { event_id: eventId, outcome: 'unmatched', note: 'no matching payment' };
  }

  return db.tx(async c => {
    const fresh = (await c.query('SELECT processed_at FROM webhook_events WHERE paypal_event_id = $1 FOR UPDATE', [eventId])).rows[0];
    if (fresh?.processed_at) return { event_id: eventId, outcome: 'skipped' as const, note: 'already processed' };
    const m = await loadMilestone(c, hit.milestone_id, true); const p = (await loadPayment(c, m.id))!;
    const hasApproval = (await c.query(`SELECT 1 FROM approvals WHERE milestone_id = $1 AND decision = 'approve' AND user_id <> $2`, [m.id, m.provider_user_id])).rowCount! > 0;
    const v = decide(ev.event_type, rid, m, p, hasApproval, now);
    const actor = `webhook(${ev.event_type})`;
    const flag = async (note: string) => {
      await updatePayment(c, p.id, { mismatch_flag: true, mismatch_note: [p.mismatch_note, note].filter(Boolean).join(' | ').slice(0, 1000) });
      await audit(c, { actor, action: 'reconcile.mismatch', targetType: 'payment', targetId: p.id, caseId: m.case_id, before: { state: m.state, payment_status: p.status }, after: { note, paypal_event_id: eventId, paypal_resource_id: rid } });
    };
    let outcome: ReconcileResult['outcome'];
    switch (v.kind) {
      case 'confirm':
        await updatePayment(c, p.id, { webhook_confirmed_at: now });
        await audit(c, { actor, action: 'reconcile.confirmed', targetType: 'payment', targetId: p.id, caseId: m.case_id, before: null, after: { note: v.note, paypal_event_id: eventId, resource_id: rid } });
        outcome = 'confirmed'; break;
      case 'apply':
        if (v.to === 'captured') await updatePayment(c, p.id, { capture_id: rid, status: 'captured', webhook_confirmed_at: now });
        else await updatePayment(c, p.id, { status: 'voided', webhook_confirmed_at: now });
        await transition(c, m, v.to, actor, { note: v.note, paypal_event_id: eventId, resource_id: rid });
        outcome = 'applied'; break;
      case 'override':
        await updatePayment(c, p.id, { status: v.payment, ...(ev.event_type.includes('CAPTURE.COMPLETED') ? { capture_id: rid, webhook_confirmed_at: now } : {}) });
        await forceState(c, m, v.to, actor, v.note);
        await flag(v.note); outcome = 'mismatch'; break;
      case 'flag':
        if (v.payment) await updatePayment(c, p.id, { status: v.payment });
        await flag(v.note); outcome = 'mismatch'; break;
      default: outcome = 'ignored';
    }
    await done(c, `${outcome}: ${v.note}`);
    return { event_id: eventId, outcome, note: v.note };
  }, hit.milestone_id);
}

/** Re-process verified-but-unprocessed events (a webhook can race our own API call, or the process may have restarted mid-way). */
export async function reconcilePending(db: Db, now = new Date()): Promise<ReconcileResult[]> {
  const { rows } = await db.query(`SELECT paypal_event_id FROM webhook_events WHERE processed_at IS NULL AND verified AND event_type = ANY($1) ORDER BY id LIMIT 100`, [RECONCILED_TYPES]);
  const out: ReconcileResult[] = [];
  for (const r of rows) { try { out.push(await reconcileEvent(db, r.paypal_event_id, now)); } catch (e) { console.error('reconcile error', r.paypal_event_id, (e as Error).message); } }
  return out;
}
