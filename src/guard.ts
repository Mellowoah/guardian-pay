import type { Db } from './db.js';
import { PayPalClient, type PayPalResult } from './paypal.js';
import { requestId, type MoneyAction } from './idempotency.js';
import type { MilestoneState } from './state.js';

export type Role = 'family' | 'provider' | 'reviewer' | 'system';
export interface Actor { userId: number | null; role: Role; label: string }
export interface ApprovalRow { decision: 'approve' | 'reject'; user_id: number; role: string; proof_sha256: string | null }
/** Facts GuardedPayPal loads from the database itself (callers cannot supply them). */
export interface GuardFacts {
  familyUserId: number | null;       // the family that owns the case
  verifiedBy: number | null;         // the reviewer who verified the proof
  verifiedProofSha: string | null;   // sha256 of the proof the reviewer verified
  currentProofSha: string | null;    // sha256 of the latest proof on file
  disputed: boolean;                 // PayPal reported a refund/dispute/chargeback on this milestone
  payee: PayeeFacts;                 // who the money goes to, and whether that payee passed BOTH checks recently
}
export interface PayeeFacts {
  merchantId: string | null;         // the PayPal merchant id bound to this case (immutable without the change flow)
  mode: 'live' | 'simulated' | null; // live = real PayPal sandbox seller; simulated = SIMULATED onboarding status
  verified: boolean;                 // latest verification of THIS merchant passed both checks (PayPal ready + authorized to practice)...
  fresh: boolean;                    // ...and is recent enough
  changePending: boolean;            // a payee change request is open (money is frozen until it is applied or cancelled)
  paymentMerchantId: string | null;  // the payee stamped on this milestone's payment when it was created
}
export interface GuardAction {
  type: MoneyAction;
  amount: number | string;
  actor: Actor;
  milestone: { id: string; state: MilestoneState; providerUserId: number };
  /** approvals loaded by GuardedPayPal from the database; callers cannot supply them */
  approvals: ApprovalRow[];
  facts: GuardFacts;
}
export type GuardDecision = { allow: true } | { allow: false; reason: string };
const deny = (reason: string): GuardDecision => ({ allow: false, reason });

export const NO_PAYEE: PayeeFacts = { merchantId: null, mode: null, verified: false, fresh: false, changePending: false, paymentMerchantId: null };
export const NO_FACTS: GuardFacts = { familyUserId: null, verifiedBy: null, verifiedProofSha: null, currentProofSha: null, disputed: false, payee: NO_PAYEE };

/** funds may only go to a bound payee that passed both checks recently, and it must be the same payee the payment was created for */
function payeeDenial(p: PayeeFacts, allowSimulated: boolean): string | null {
  if (!p.merchantId) return 'no payee is bound to this case (the provider must complete PayPal seller onboarding)';
  if (p.changePending) return 'a payee change is pending; funds are frozen until it is applied or cancelled';
  if (!p.verified) return 'the payee is not verified (needs BOTH: PayPal ready to receive AND authorized to practice)';
  if (!p.fresh) return 'the payee verification is out of date; it must be re-checked';
  if (p.mode === 'simulated' && !allowSimulated) return 'simulated payees are not allowed here';
  if (p.paymentMerchantId !== p.merchantId) return 'the payment was created for a different payee than the one now bound to the case';
  return null;
}

/**
 * Policy gate for every PayPal money call. Rule: the AI suggests, a human decides, PayPal moves the money.
 * Separation of duties: the reviewer VERIFIES the proof; the case's FAMILY APPROVES (and only the family can fund or capture).
 * The family approval must be bound to the exact proof (sha256) the reviewer verified and the family saw.
 */
export function checkMandate(a: GuardAction, opts: { allowSimulatedPayee?: boolean } = {}): GuardDecision {
  const amt = Number(a.amount);
  if (!Number.isFinite(amt) || amt <= 0) return deny('amount must be greater than 0');
  if (!a.milestone?.id) return deny('milestone required');
  const f = a.facts;
  const isCaseFamily = a.actor.role === 'family' && a.actor.userId !== null && a.actor.userId === f.familyUserId;
  const provider = a.milestone.providerUserId;
  const rejectOk = (ap: ApprovalRow) => ap.decision === 'reject' && ap.user_id !== provider && (ap.role === 'reviewer' || (ap.role === 'family' && ap.user_id === f.familyUserId));

  switch (a.type) {
    case 'order':
    case 'authorize':
      if (!isCaseFamily) return deny(`only the case's family can fund a milestone (actor role ${a.actor.role})`);
      { const d = payeeDenial(f.payee, opts.allowSimulatedPayee !== false); if (d) return deny(d); }
      return { allow: true };
    case 'capture': {
      if (!isCaseFamily) return deny(`capture requires the case's family (actor role ${a.actor.role})`);
      { const d = payeeDenial(f.payee, opts.allowSimulatedPayee !== false); if (d) return deny(d); }
      if (a.milestone.state !== 'verified') return deny(`capture requires milestone state verified (is ${a.milestone.state})`);
      if (f.disputed) return deny('milestone has a refund/dispute flag from PayPal; a human must resolve it first');
      if (f.verifiedBy === null) return deny('capture requires a reviewer verification (verified_by missing)');
      if (f.verifiedBy === a.actor.userId || f.verifiedBy === provider) return deny('the verifier and the approver must be different people, and neither may be the provider');
      if (!f.currentProofSha || f.verifiedProofSha !== f.currentProofSha) return deny('the proof changed after it was verified; it must be verified again');
      const mine = a.approvals.filter(ap => ap.decision === 'approve' && ap.role === 'family' && ap.user_id === f.familyUserId);
      if (!mine.length) return deny('capture requires a recorded human approval');
      if (!mine.some(ap => ap.proof_sha256 === f.currentProofSha)) return deny('stale approval: the family approved a different proof than the one on file');
      if (a.approvals.some(ap => ap.decision === 'reject' && ap.role === 'family' && ap.user_id === f.familyUserId && ap.proof_sha256 === f.currentProofSha)) return deny('the family rejected this proof');
      return { allow: true };
    }
    case 'void':
      if (!(isCaseFamily || a.actor.role === 'reviewer')) return deny(`role ${a.actor.role} may not void`);
      if (a.milestone.state !== 'rejected') return deny(`void requires milestone state rejected (is ${a.milestone.state})`);
      if (!a.approvals.some(rejectOk)) return deny('void requires a recorded human rejection');
      return { allow: true };
    case 'reauthorize':
      if (a.actor.role !== 'system' && a.actor.role !== 'reviewer') return deny(`role ${a.actor.role} may not reauthorize`);
      if (!['authorized', 'reauthorized', 'proof_submitted', 'verified'].includes(a.milestone.state)) return deny(`cannot reauthorize in state ${a.milestone.state}`);
      return { allow: true };
    default:
      return deny('unknown action');
  }
}

export class GuardDenied extends Error {
  constructor(public reason: string, public action: MoneyAction) { super(`guard denied ${action}: ${reason}`); this.name = 'GuardDenied'; }
}

export interface GuardCtx { actor: Actor; milestone: GuardAction['milestone']; amount: string; attempt: number }

/**
 * The ONLY way application code reaches PayPal money endpoints. It loads the approval rows itself from
 * the database (the caller cannot hand it approvals), runs checkMandate, and only then calls the client.
 */
export interface GuardOpts { payeeMaxAgeHours?: number; allowSimulatedPayee?: boolean }
export class GuardedPayPal {
  private maxAgeHours: number; private allowSim: boolean;
  constructor(private client: PayPalClient, private db: Pick<Db, 'query'>, opts: GuardOpts = {}) { this.maxAgeHours = opts.payeeMaxAgeHours ?? 24; this.allowSim = opts.allowSimulatedPayee !== false; }

  private async loadFacts(milestoneId: string): Promise<GuardFacts> {
    const r = (await this.db.query(
      `SELECT c.family_user_id, m.verified_by, m.verified_proof_sha256, m.disputed_at, c.payee_merchant_id, c.payee_mode, pay.payee_merchant_id AS payment_merchant_id,
              (SELECT v.verified FROM provider_verifications v WHERE v.provider_id = c.provider_id AND v.merchant_id IS NOT DISTINCT FROM c.payee_merchant_id ORDER BY v.id DESC LIMIT 1) AS pv_ok,
              (SELECT v.checked_at > now() - make_interval(hours => $2::int) FROM provider_verifications v WHERE v.provider_id = c.provider_id AND v.merchant_id IS NOT DISTINCT FROM c.payee_merchant_id ORDER BY v.id DESC LIMIT 1) AS pv_fresh,
              EXISTS (SELECT 1 FROM payee_change_requests r WHERE r.case_id = c.id AND r.status IN ('pending','approved')) AS change_pending,
              (SELECT sha256 FROM proofs WHERE milestone_id = m.id ORDER BY created_at DESC, id DESC LIMIT 1) AS current_proof_sha
         FROM milestones m JOIN cases c ON c.id = m.case_id LEFT JOIN payments pay ON pay.milestone_id = m.id WHERE m.id = $1`, [milestoneId, Math.max(1, Math.ceil(this.maxAgeHours))])).rows[0];
    if (!r) return NO_FACTS;
    return { familyUserId: r.family_user_id, verifiedBy: r.verified_by, verifiedProofSha: r.verified_proof_sha256, currentProofSha: r.current_proof_sha, disputed: !!r.disputed_at,
      payee: { merchantId: r.payee_merchant_id ?? null, mode: r.payee_mode ?? null, verified: r.pv_ok === true, fresh: r.pv_fresh === true, changePending: !!r.change_pending, paymentMerchantId: r.payment_merchant_id ?? null } };
  }

  private async gate(type: MoneyAction, ctx: GuardCtx): Promise<{ rid: string; facts: GuardFacts }> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT a.decision, a.user_id, u.role, a.proof_sha256 FROM approvals a JOIN users u ON u.id = a.user_id WHERE a.milestone_id = $1`, [ctx.milestone.id]);
    const facts = await this.loadFacts(ctx.milestone.id);
    const d = checkMandate({ type, amount: ctx.amount, actor: ctx.actor, milestone: ctx.milestone, approvals: rows, facts }, { allowSimulatedPayee: this.allowSim });
    if (!d.allow) throw new GuardDenied(d.reason, type);
    return { rid: requestId(ctx.milestone.id, type, ctx.attempt), facts };
  }

  /** The guard decides who gets paid: it sets purchase_units[0].payee.merchant_id to the case's bound payee (live mode), so funds go to the provider, not the platform. In simulated mode no payee is sent (no real PayPal account exists behind a simulated id). */
  async order(ctx: GuardCtx, order: any): Promise<PayPalResult> {
    const { rid, facts } = await this.gate('order', ctx);
    const body = { ...order, purchase_units: (order?.purchase_units ?? []).map((u: any, i: number) => { const { payee: _drop, ...rest } = u ?? {}; return i === 0 && facts.payee.mode === 'live' ? { ...rest, payee: { merchant_id: facts.payee.merchantId } } : rest; }) };
    return this.client.createOrder(body, rid);
  }
  async authorize(ctx: GuardCtx, orderId: string): Promise<PayPalResult> { return this.client.authorizeOrder(orderId, (await this.gate('authorize', ctx)).rid); }
  async capture(ctx: GuardCtx, authId: string, currency: string): Promise<PayPalResult> {
    const { rid } = await this.gate('capture', ctx);
    return this.client.captureAuthorization(authId, { amount: { currency_code: currency, value: ctx.amount }, final_capture: true }, rid);
  }
  /** void always targets the ORIGINAL authorization (a reauthorized one cannot be voided directly) */
  async void(ctx: GuardCtx, originalAuthId: string): Promise<PayPalResult> { return this.client.voidAuthorization(originalAuthId, (await this.gate('void', ctx)).rid); }
  async reauthorize(ctx: GuardCtx, authId: string, currency: string): Promise<PayPalResult> {
    const { rid } = await this.gate('reauthorize', ctx);
    return this.client.reauthorizeAuthorization(authId, { amount: { currency_code: currency, value: ctx.amount } }, rid);
  }
  // reads pass through (no money moves)
  getAuthorization(id: string) { return this.client.getAuthorization(id); }
  getOrder(id: string) { return this.client.getOrder(id); }
}
