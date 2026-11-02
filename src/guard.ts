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

export const NO_FACTS: GuardFacts = { familyUserId: null, verifiedBy: null, verifiedProofSha: null, currentProofSha: null, disputed: false };

/**
 * Policy gate for every PayPal money call. Rule: the AI suggests, a human decides, PayPal moves the money.
 * Separation of duties: the reviewer VERIFIES the proof; the case's FAMILY APPROVES (and only the family can fund or capture).
 * The family approval must be bound to the exact proof (sha256) the reviewer verified and the family saw.
 */
export function checkMandate(a: GuardAction): GuardDecision {
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
      return { allow: true };
    case 'capture': {
      if (!isCaseFamily) return deny(`capture requires the case's family (actor role ${a.actor.role})`);
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
export class GuardedPayPal {
  constructor(private client: PayPalClient, private db: Pick<Db, 'query'>) {}

  private async loadFacts(milestoneId: string): Promise<GuardFacts> {
    const r = (await this.db.query(
      `SELECT c.family_user_id, m.verified_by, m.verified_proof_sha256, m.disputed_at,
              (SELECT sha256 FROM proofs WHERE milestone_id = m.id ORDER BY created_at DESC, id DESC LIMIT 1) AS current_proof_sha
         FROM milestones m JOIN cases c ON c.id = m.case_id WHERE m.id = $1`, [milestoneId])).rows[0];
    if (!r) return NO_FACTS;
    return { familyUserId: r.family_user_id, verifiedBy: r.verified_by, verifiedProofSha: r.verified_proof_sha256, currentProofSha: r.current_proof_sha, disputed: !!r.disputed_at };
  }

  private async gate(type: MoneyAction, ctx: GuardCtx): Promise<string> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT a.decision, a.user_id, u.role, a.proof_sha256 FROM approvals a JOIN users u ON u.id = a.user_id WHERE a.milestone_id = $1`, [ctx.milestone.id]);
    const facts = await this.loadFacts(ctx.milestone.id);
    const d = checkMandate({ type, amount: ctx.amount, actor: ctx.actor, milestone: ctx.milestone, approvals: rows, facts });
    if (!d.allow) throw new GuardDenied(d.reason, type);
    return requestId(ctx.milestone.id, type, ctx.attempt);
  }

  async order(ctx: GuardCtx, order: unknown): Promise<PayPalResult> { return this.client.createOrder(order, await this.gate('order', ctx)); }
  async authorize(ctx: GuardCtx, orderId: string): Promise<PayPalResult> { return this.client.authorizeOrder(orderId, await this.gate('authorize', ctx)); }
  async capture(ctx: GuardCtx, authId: string, currency: string): Promise<PayPalResult> {
    const rid = await this.gate('capture', ctx);
    return this.client.captureAuthorization(authId, { amount: { currency_code: currency, value: ctx.amount }, final_capture: true }, rid);
  }
  /** void always targets the ORIGINAL authorization (a reauthorized one cannot be voided directly) */
  async void(ctx: GuardCtx, originalAuthId: string): Promise<PayPalResult> { return this.client.voidAuthorization(originalAuthId, await this.gate('void', ctx)); }
  async reauthorize(ctx: GuardCtx, authId: string, currency: string): Promise<PayPalResult> {
    const rid = await this.gate('reauthorize', ctx);
    return this.client.reauthorizeAuthorization(authId, { amount: { currency_code: currency, value: ctx.amount } }, rid);
  }
  // reads pass through (no money moves)
  getAuthorization(id: string) { return this.client.getAuthorization(id); }
  getOrder(id: string) { return this.client.getOrder(id); }
}
