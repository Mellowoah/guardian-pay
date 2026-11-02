export const STATES = ['created', 'authorized', 'reauthorized', 'proof_submitted', 'verified', 'captured', 'rejected', 'voided', 'expired'] as const;
export type MilestoneState = (typeof STATES)[number];

/**
 * created -> authorized -> (reauthorized) -> proof_submitted -> verified -> captured
 * proof_submitted | verified -> rejected -> voided   (the family may reject/dispute even after the reviewer verified)
 * authorized | reauthorized -> expired at day 29 (we also allow proof_submitted | verified -> expired, since the
 * authorization lapses at day 29 regardless of where review is).
 */
export const TRANSITIONS: Record<MilestoneState, readonly MilestoneState[]> = {
  created: ['authorized'],
  authorized: ['reauthorized', 'proof_submitted', 'expired'],
  reauthorized: ['proof_submitted', 'expired'],
  proof_submitted: ['verified', 'rejected', 'expired'],
  verified: ['captured', 'rejected', 'expired'],
  rejected: ['voided'],
  captured: [],
  voided: [],
  expired: [],
};

export class IllegalTransition extends Error {
  constructor(public from: string, public to: string) { super(`illegal milestone transition ${from} -> ${to}`); this.name = 'IllegalTransition'; }
}

export const canTransition = (from: MilestoneState, to: MilestoneState) => TRANSITIONS[from]?.includes(to) ?? false;
export function assertTransition(from: MilestoneState, to: MilestoneState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}
/** states in which an authorization is live and funds are being held */
export const HOLDING: readonly MilestoneState[] = ['authorized', 'reauthorized', 'proof_submitted', 'verified'];
