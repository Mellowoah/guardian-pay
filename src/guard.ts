import type { Db } from './db.js';
import { PayPalClient, type PayPalResult } from './paypal.js';
import { requestId, type MoneyAction } from './idempotency.js';
import type { MilestoneState } from './state.js';

export type Role = 'family' | 'provider' | 'reviewer' | 'system';
export interface Actor { userId: number | null; role: Role; label: string }
export interface ApprovalRow { decision: 'approve' | 'reject'; user_id: number; role: string }
export interface GuardAction {
  type: MoneyAction;
  amount: number | string;
  actor: Actor;
  milestone: { id: string; state: MilestoneState; providerUserId: number };
  /** approvals loaded by GuardedPayPal from the database; callers cannot supply them */
  approvals: ApprovalRow[];
}
export type GuardDecision = { allow: true } | { allow: false; reason: string };
const deny = (reason: string): GuardDecision => ({ allow: false, reason });

const BUYER_ROLES: Role[] = ['family', 'reviewer'];
const HUMAN_APPROVER_ROLES = ['family', 'reviewer'];

/**
 * Policy gate for every PayPal money call. Rule: the AI suggests, a human decides, PayPal moves the money.
 * Layer 1 enforces: amount > 0, role checks, and "capture requires a recorded human approval".
 * (Layer 2 will add mandate limits.)
 */
export function checkMandate(a: GuardAction): GuardDecision {
  const amt = Number(a.amount);
  if (!Number.isFinite(amt) || amt <= 0) return deny('amount must be greater than 0');
  if (!a.milestone?.id) return deny('milestone required');
  const humanOk = (ap: ApprovalRow, decision: string) =>
    ap.decision === decision && HUMAN_APPROVER_ROLES.includes(ap.role) && ap.user_id !== a.milestone.providerUserId;

  switch (a.type) {
    case 'order':
    case 'authorize':
      if (!BUYER_ROLES.includes(a.actor.role)) return deny(`role ${a.actor.role} may not fund a milestone`);
      return { allow: true };
    case 'capture':
      if (!BUYER_ROLES.includes(a.actor.role)) return deny(`role ${a.actor.role} may not capture`);
      if (a.actor.userId !== null && a.actor.userId === a.milestone.providerUserId) return deny('a provider cannot capture its own milestone');
      if (a.milestone.state !== 'verified') return deny(`capture requires milestone state verified (is ${a.milestone.state})`);
      if (!a.approvals.some(ap => humanOk(ap, 'approve'))) return deny('capture requires a recorded human approval');
      return { allow: true };
    case 'void':
      if (!BUYER_ROLES.includes(a.actor.role)) return deny(`role ${a.actor.role} may not void`);
      if (a.milestone.state !== 'rejected') return deny(`void requires milestone state rejected (is ${a.milestone.state})`);
      if (!a.approvals.some(ap => humanOk(ap, 'reject'))) return deny('void requires a recorded human rejection');
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

  private async gate(type: MoneyAction, ctx: GuardCtx): Promise<string> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT a.decision, a.user_id, u.role FROM approvals a JOIN users u ON u.id = a.user_id WHERE a.milestone_id = $1`, [ctx.milestone.id]);
    const d = checkMandate({ type, amount: ctx.amount, actor: ctx.actor, milestone: ctx.milestone, approvals: rows });
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
