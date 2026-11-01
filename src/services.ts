import type { Db } from './db.js';
import { GuardedPayPal, GuardDenied, checkMandate, type Actor, type GuardCtx } from './guard.js';
import { isDefinitiveFailure, paypalIssue, type PayPalResult } from './paypal.js';
import { audit } from './audit.js';
import { clock, addDays } from './clock.js';
import { HOLDING } from './state.js';
import { HttpError, loadMilestone, loadPayment, transition, updatePayment, actorLabel, attemptOf, bumped, type MilestoneRow, type PaymentRow } from './repo.js';

const BUYERS = ['family', 'reviewer'];
// Sandbox-only demo card (PayPal sandbox test Visa). Clients never send card data; they only ask for the demo card.
const SANDBOX_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Demo Buyer (sandbox)',
  billing_address: { address_line_1: '123 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } };

export interface ServiceOpts { publicBaseUrl: string; allowSandboxCard: boolean }

const AMOUNT_RE = /^\d{1,5}(\.\d{1,2})?$/;
const str = (v: unknown, max: number, field: string, required = true): string => {
  if (typeof v !== 'string' || (required && !v.trim())) { if (!required && v == null) return ''; throw new HttpError(400, 'bad_request', `${field} is required`); }
  if (v.length > max) throw new HttpError(400, 'bad_request', `${field} too long`);
  return v.trim();
};

export class Service {
  constructor(private db: Db, private guarded: GuardedPayPal, private opts: ServiceOpts) {}

  // ------------------------------------------------------------------ cases
  async createCase(actor: Actor, body: any) {
    if (actor.role !== 'provider') throw new HttpError(403, 'forbidden', 'only a provider can create a case');
    const title = str(body?.title, 200, 'title'); const description = str(body?.description, 2000, 'description', false);
    const ms = body?.milestones;
    if (!Array.isArray(ms) || ms.length < 1 || ms.length > 10) throw new HttpError(400, 'bad_request', 'milestones: 1-10 required');
    const items = ms.map((m: any, i: number) => {
      const amt = String(m?.amount ?? '');
      if (!AMOUNT_RE.test(amt) || Number(amt) <= 0 || Number(amt) > 10000) throw new HttpError(400, 'bad_request', `milestones[${i}].amount must be 0.01-10000.00`);
      return { title: str(m?.title, 200, `milestones[${i}].title`), amount: Number(amt).toFixed(2) };
    });
    const familyName = typeof body?.family_username === 'string' ? body.family_username : 'family_demo';
    return this.db.tx(async c => {
      const prov = (await c.query('SELECT id FROM providers WHERE user_id = $1', [actor.userId])).rows[0];
      if (!prov) throw new HttpError(403, 'forbidden', 'no provider profile');
      const fam = (await c.query(`SELECT id FROM users WHERE username = $1 AND role = 'family'`, [familyName])).rows[0];
      if (!fam) throw new HttpError(400, 'bad_request', 'unknown family_username');
      const cs = (await c.query('INSERT INTO cases (title, description, provider_id, family_user_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [title, description || null, prov.id, fam.id])).rows[0];
      await audit(c, { actor: actorLabel(actor), action: 'case.create', targetType: 'case', targetId: cs.id, caseId: cs.id, before: null, after: { title, milestones: items.length } });
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const m = (await c.query('INSERT INTO milestones (case_id, seq, title, amount) VALUES ($1,$2,$3,$4) RETURNING *', [cs.id, i + 1, items[i].title, items[i].amount])).rows[0];
        await audit(c, { actor: actorLabel(actor), action: 'milestone.created', targetType: 'milestone', targetId: m.id, caseId: cs.id, before: null, after: { state: 'created', amount: m.amount } });
        out.push(publicMilestone(m));
      }
      return { id: cs.id, title: cs.title, currency: cs.currency, milestones: out };
    });
  }

  private async assertCaseAccess(actor: Actor, caseId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new HttpError(404, 'not_found', 'case not found');
    const r = (await this.db.query(`SELECT c.*, p.user_id AS provider_user_id FROM cases c JOIN providers p ON p.id = c.provider_id WHERE c.id = $1`, [caseId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'case not found');
    if (actor.role === 'provider' && actor.userId !== r.provider_user_id) throw new HttpError(403, 'forbidden', 'not your case');
    if (actor.role === 'family' && r.family_user_id !== actor.userId) throw new HttpError(403, 'forbidden', 'not your case');
    return r;
  }

  async getCase(actor: Actor, caseId: string) {
    const cs = await this.assertCaseAccess(actor, caseId);
    const ms = (await this.db.query(
      `SELECT m.*, row_to_json(p) AS payment FROM milestones m LEFT JOIN payments p ON p.milestone_id = m.id WHERE m.case_id = $1 ORDER BY m.seq`, [caseId])).rows;
    return { id: cs.id, title: cs.title, currency: cs.currency, milestones: ms.map(m => ({ ...publicMilestone(m), payment: m.payment ? publicPayment(m.payment) : null })) };
  }

  async getAudit(actor: Actor, caseId: string) {
    await this.assertCaseAccess(actor, caseId);
    const rows = (await this.db.query('SELECT id, at, actor, action, target_type, target_id, before, after FROM audit_log WHERE case_id = $1 ORDER BY id', [caseId])).rows;
    return { case_id: caseId, count: rows.length, entries: rows };
  }

  // ------------------------------------------------------------------ funding
  private ctx(actor: Actor, m: MilestoneRow, p: PaymentRow | null, action: string, state = m.state): GuardCtx {
    return { actor, milestone: { id: m.id, state, providerUserId: m.provider_user_id }, amount: m.amount, attempt: attemptOf(p, action) };
  }
  private failure(res: PayPalResult, fallback: string): HttpError {
    const issue = paypalIssue(res.body);
    return new HttpError(res.status >= 500 ? 502 : 422, 'paypal_error', `${fallback}: ${issue}`, { paypal_status: res.status, paypal_issue: issue });
  }
  private async recordFailure(m: MilestoneRow, action: string, res: PayPalResult) {
    await this.db.tx(async c => {
      const p = await loadPayment(c, m.id); if (!p) return;
      const sets: Record<string, unknown> = { last_error: `${action}: ${res.status} ${paypalIssue(res.body)}` };
      if (isDefinitiveFailure(res.status)) sets.attempts = bumped(p, action);
      await updatePayment(c, p.id, sets);
    }, m.id);
  }

  async openOrder(actor: Actor, milestoneId: string, body: any) {
    const useCard = body?.payment_source === 'card';
    if (useCard && !this.opts.allowSandboxCard) throw new HttpError(400, 'bad_request', 'sandbox card disabled');
    if (body?.payment_source && !['card', 'paypal'].includes(body.payment_source)) throw new HttpError(400, 'bad_request', 'payment_source must be card or paypal');
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      if (!BUYERS.includes(actor.role)) throw new HttpError(403, 'forbidden', `role ${actor.role} may not fund a milestone`);
      let p = await loadPayment(c, m.id);
      if (m.state !== 'created') throw new HttpError(409, 'conflict', `milestone is ${m.state}`);
      if (p?.status === 'order_created') { if (useCard) throw new HttpError(409, 'conflict', 'a PayPal-wallet order already exists for this milestone'); return { m, p, existing: true }; }
      if (p && p.status !== 'pending_order') throw new HttpError(409, 'conflict', `payment is ${p.status}`);
      if (!p) {
        p = (await c.query('INSERT INTO payments (milestone_id, amount, currency) VALUES ($1,$2,$3) RETURNING *', [m.id, m.amount, m.currency])).rows[0];
        await audit(c, { actor: actorLabel(actor), action: 'payment.create', targetType: 'payment', targetId: p!.id, caseId: m.case_id, before: null, after: { status: 'pending_order', amount: m.amount } });
      }
      return { m, p: p!, existing: false };
    }, milestoneId);
    if (pre.existing) return { milestone: publicMilestone(pre.m), payment: publicPayment(pre.p), approve_url: pre.p.approve_url };

    const { m, p } = pre;
    const payment_source = useCard ? { card: SANDBOX_CARD } : { paypal: { experience_context: {
      brand_name: 'Guardian Pay (sandbox demo)', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
      return_url: `${this.opts.publicBaseUrl}/paypal/return`, cancel_url: `${this.opts.publicBaseUrl}/paypal/cancel` } } };
    const res = await this.guarded.order(this.ctx(actor, m, p, 'order'), {
      intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'default', custom_id: m.id, description: `Guardian Pay milestone ${m.seq} (sandbox, synthetic)`,
        amount: { currency_code: m.currency, value: m.amount } }], payment_source });
    if (res.status >= 300) { await this.recordFailure(m, 'order', res); throw this.failure(res, 'order failed'); }

    if (useCard) {
      const auth = res.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth || auth.status !== 'CREATED') { await this.recordFailure(m, 'order', { status: 422, body: { name: `AUTH_${auth?.status ?? 'MISSING'}` } }); throw new HttpError(422, 'paypal_error', `card authorization status ${auth?.status ?? 'missing'}`); }
      return this.db.tx(c => this.applyAuthorized(c, actor, m.id, res.body.id, auth), m.id);
    }
    const link = (res.body?.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!link) throw new HttpError(502, 'paypal_error', 'no approval link returned');
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (p2.status === 'pending_order') await updatePayment(c, p2.id, { paypal_order_id: res.body.id, approve_url: link, status: 'order_created', last_error: null });
      const p3 = (await loadPayment(c, m.id))!;
      return { milestone: publicMilestone(m2), payment: publicPayment(p3), approve_url: p3.approve_url };
    }, m.id);
  }

  async authorizeWallet(actor: Actor, milestoneId: string) {
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      if (!BUYERS.includes(actor.role)) throw new HttpError(403, 'forbidden', `role ${actor.role} may not authorize`);
      if (m.state !== 'created') { if (p && ['authorized', 'reauthorized'].includes(p.status)) return { m, p, done: true }; throw new HttpError(409, 'conflict', `milestone is ${m.state}`); }
      if (!p || p.status !== 'order_created' || !p.paypal_order_id) throw new HttpError(409, 'conflict', 'create an order with payment_source=paypal first');
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: publicPayment(pre.p), idempotent: true };
    const res = await this.guarded.authorize(this.ctx(actor, pre.m, pre.p, 'authorize'), pre.p.paypal_order_id!);
    if (res.status >= 300) {
      await this.recordFailure(pre.m, 'authorize', res);
      const issue = paypalIssue(res.body);
      throw new HttpError(issue === 'ORDER_NOT_APPROVED' ? 409 : 422, issue === 'ORDER_NOT_APPROVED' ? 'buyer_approval_required' : 'paypal_error',
        issue === 'ORDER_NOT_APPROVED' ? 'the buyer has not approved the order yet; open approve_url first' : `authorize failed: ${issue}`, { paypal_issue: issue, approve_url: pre.p.approve_url });
    }
    const auth = res.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth || auth.status !== 'CREATED') throw new HttpError(422, 'paypal_error', `authorization status ${auth?.status ?? 'missing'}`);
    return this.db.tx(c => this.applyAuthorized(c, actor, pre.m.id, pre.p.paypal_order_id!, auth), pre.m.id);
  }

  private async applyAuthorized(c: import('pg').PoolClient, actor: Actor, milestoneId: string, orderId: string, auth: any) {
    const m = await loadMilestone(c, milestoneId, true); const p = (await loadPayment(c, milestoneId))!;
    if (m.state === 'created') {
      const now = clock.now();
      await updatePayment(c, p.id, { paypal_order_id: orderId, original_authorization_id: auth.id, current_authorization_id: auth.id, authorized_at: now,
        honor_until: addDays(now, 3), expires_at: addDays(now, 29), status: 'authorized', last_error: null });
      await transition(c, m, 'authorized', actorLabel(actor), { order_id: orderId, authorization_id: auth.id, amount: m.amount });
    }
    const p2 = (await loadPayment(c, milestoneId))!;
    return { milestone: publicMilestone(m), payment: publicPayment(p2) };
  }

  // ------------------------------------------------------------------ proof / verify
  async submitProof(actor: Actor, milestoneId: string, body: any) {
    const note = str(body?.note, 2000, 'note');
    return this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      if (actor.role !== 'provider' || actor.userId !== m.provider_user_id) throw new HttpError(403, 'forbidden', 'only the case provider can submit proof');
      if (m.state === 'proof_submitted') return { milestone: publicMilestone(m), idempotent: true };
      await transition(c, m, 'proof_submitted', actorLabel(actor), { note_length: note.length }, { proof_note: note, proof_submitted_at: clock.now() });
      m.proof_note = note; return { milestone: publicMilestone(m) };
    }, milestoneId);
  }

  async verifyProof(actor: Actor, milestoneId: string, body: any) {
    const note = str(body?.note, 1000, 'note', false);
    return this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      if (actor.role !== 'reviewer') throw new HttpError(403, 'forbidden', 'only a reviewer can verify proof');
      if (m.state === 'verified') return { milestone: publicMilestone(m), idempotent: true };
      await transition(c, m, 'verified', actorLabel(actor), { note }, { verified_note: note || null });
      return { milestone: publicMilestone(m) };
    }, milestoneId);
  }

  // ------------------------------------------------------------------ approve -> capture
  async approve(actor: Actor, milestoneId: string) {
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      if (!BUYERS.includes(actor.role)) throw new HttpError(403, 'forbidden', `role ${actor.role} may not approve`);
      if (actor.userId === m.provider_user_id) throw new HttpError(403, 'forbidden', 'a provider cannot approve its own milestone');
      if (m.state === 'captured') return { m, p, done: true };
      if (m.state !== 'verified') throw new HttpError(409, 'conflict', `milestone must be verified to approve (is ${m.state})`);
      if (!p?.current_authorization_id) throw new HttpError(409, 'conflict', 'no authorization on this milestone');
      const have = (await c.query(`SELECT 1 FROM approvals WHERE milestone_id=$1 AND user_id=$2 AND decision='approve'`, [m.id, actor.userId])).rowCount;
      if (!have) {
        await c.query(`INSERT INTO approvals (milestone_id, user_id, decision) VALUES ($1,$2,'approve')`, [m.id, actor.userId]);
        await audit(c, { actor: actorLabel(actor), action: 'approval.approve', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: null, after: { decision: 'approve' } });
      }
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: pre.p ? publicPayment(pre.p) : null, idempotent: true };

    const { m, p } = pre;
    let res: PayPalResult;
    try { res = await this.guarded.capture(this.ctx(actor, m, p, 'capture', 'verified'), p!.current_authorization_id!, m.currency); }
    catch (e) { if (e instanceof GuardDenied) throw new HttpError(403, 'guard_denied', e.reason); throw e; }

    let captureId: string | undefined; let captureStatus: string | undefined;
    if (res.status < 300) { captureId = res.body?.id; captureStatus = res.body?.status; }
    else if (paypalIssue(res.body) === 'AUTHORIZATION_ALREADY_CAPTURED') {
      const ord = await this.guarded.getOrder(p!.paypal_order_id!);
      const cap = ord.body?.purchase_units?.[0]?.payments?.captures?.[0];
      captureId = cap?.id; captureStatus = cap?.status;
    }
    if (!captureId) { await this.recordFailure(m, 'capture', res); throw this.failure(res, 'capture failed'); }

    if (captureStatus !== 'COMPLETED') {
      await this.db.tx(async c => { const p2 = (await loadPayment(c, m.id))!;
        if (!p2.capture_id) await updatePayment(c, p2.id, { capture_id: captureId, status: 'capture_pending', last_error: `capture ${captureStatus}` }); }, m.id);
      throw new HttpError(202, 'capture_pending', `capture ${captureStatus}; the PAYMENT.CAPTURE.COMPLETED webhook will finish it`, { capture_id: captureId });
    }
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (m2.state === 'captured') return { milestone: publicMilestone(m2), payment: publicPayment(p2), idempotent: true };
      await updatePayment(c, p2.id, { capture_id: captureId, status: 'captured', last_error: null });
      await transition(c, m2, 'captured', actorLabel(actor), { capture_id: captureId, authorization_id: p2.current_authorization_id, amount: m2.amount });
      return { milestone: publicMilestone(m2), payment: publicPayment((await loadPayment(c, m.id))!) };
    }, m.id);
  }

  // ------------------------------------------------------------------ reject -> void
  async reject(actor: Actor, milestoneId: string, body: any) {
    const reason = str(body?.reason, 500, 'reason');
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      if (!BUYERS.includes(actor.role)) throw new HttpError(403, 'forbidden', `role ${actor.role} may not reject`);
      if (actor.userId === m.provider_user_id) throw new HttpError(403, 'forbidden', 'a provider cannot reject its own milestone');
      if (m.state === 'voided') return { m, p, done: true };
      if (m.state === 'proof_submitted') {
        await c.query(`INSERT INTO approvals (milestone_id, user_id, decision, reason) VALUES ($1,$2,'reject',$3)`, [m.id, actor.userId, reason]);
        await audit(c, { actor: actorLabel(actor), action: 'approval.reject', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: null, after: { decision: 'reject', reason } });
        await transition(c, m, 'rejected', actorLabel(actor), { reason }, { rejection_reason: reason });
      } else if (m.state !== 'rejected') throw new HttpError(409, 'conflict', `milestone must be proof_submitted to reject (is ${m.state})`);
      if (!p?.original_authorization_id) throw new HttpError(409, 'conflict', 'no authorization on this milestone');
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: pre.p ? publicPayment(pre.p) : null, idempotent: true };

    const { m, p } = pre;
    let res: PayPalResult;
    try { res = await this.guarded.void(this.ctx(actor, m, p, 'void', 'rejected'), p!.original_authorization_id!); }
    catch (e) { if (e instanceof GuardDenied) throw new HttpError(403, 'guard_denied', e.reason); throw e; }
    let ok = res.status < 300;
    if (!ok && paypalIssue(res.body) === 'AUTHORIZATION_VOIDED') ok = (await this.guarded.getAuthorization(p!.original_authorization_id!)).body?.status === 'VOIDED';
    if (!ok) { await this.recordFailure(m, 'void', res); throw this.failure(res, 'void failed (milestone stays rejected; retry reject)'); }
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (m2.state === 'voided') return { milestone: publicMilestone(m2), payment: publicPayment(p2), idempotent: true };
      await updatePayment(c, p2.id, { status: 'voided', last_error: null });
      await transition(c, m2, 'voided', actorLabel(actor), { authorization_id: p2.original_authorization_id });
      return { milestone: publicMilestone(m2), payment: publicPayment((await loadPayment(c, m.id))!) };
    }, m.id);
  }
}

export const HOLDING_STATES = HOLDING;
export const publicMilestone = (m: any) => ({ id: m.id, case_id: m.case_id, seq: m.seq, title: m.title, amount: m.amount, state: m.state,
  proof_note: m.proof_note ?? null, rejection_reason: m.rejection_reason ?? null });
export const publicPayment = (p: any) => ({ id: p.id, status: p.status, amount: p.amount, currency: p.currency, order_id: p.paypal_order_id,
  original_authorization_id: p.original_authorization_id, current_authorization_id: p.current_authorization_id, authorized_at: p.authorized_at,
  reauthorized_at: p.reauthorized_at, honor_until: p.honor_until, expires_at: p.expires_at, capture_id: p.capture_id, reauth_count: p.reauth_count,
  last_error: p.last_error, mismatch_flag: p.mismatch_flag, mismatch_note: p.mismatch_note, webhook_confirmed_at: p.webhook_confirmed_at });
export { checkMandate };
