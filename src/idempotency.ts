export type MoneyAction = 'order' | 'authorize' | 'capture' | 'void' | 'reauthorize';

/**
 * Deterministic PayPal-Request-Id: milestone id + action + attempt.
 * Retrying the same logical call reuses the same key (PayPal returns the original result, no double charge).
 * The attempt number only goes up after a definitive PayPal 4xx failure was recorded.
 */
export function requestId(milestoneId: string, action: MoneyAction, attempt: number): string {
  if (!milestoneId || !/^[0-9a-f-]{36}$/i.test(milestoneId)) throw new Error('milestoneId must be a uuid');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  return `gp-${milestoneId}-${action}-${attempt}`; // 3+36+1+<=11+1+digits, well under PayPal's 108-char limit
}
