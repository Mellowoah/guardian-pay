import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkMandate, GuardedPayPal, GuardDenied, type Actor, type GuardAction } from '../src/guard.js';
import { PayPalClient } from '../src/paypal.js';

const M = '123e4567-e89b-12d3-a456-426614174000';
const family: Actor = { userId: 1, role: 'family', label: 'family_demo' };
const provider: Actor = { userId: 2, role: 'provider', label: 'provider_demo' };
const base = (o: Partial<GuardAction>): GuardAction => ({ type: 'capture', amount: '10.00', actor: family,
  milestone: { id: M, state: 'verified', providerUserId: 2 }, approvals: [], ...o });
const approve = { decision: 'approve' as const, user_id: 1, role: 'family' };

test('guard: amount must be > 0', () => {
  for (const amount of ['0', '-5', 'abc', 0]) assert.equal(checkMandate(base({ type: 'order', amount, approvals: [approve] })).allow, false);
  assert.equal(checkMandate(base({ type: 'order', amount: '0.01' })).allow, true);
});
test('guard: capture requires a recorded human approval', () => {
  const d = checkMandate(base({ approvals: [] }));
  assert.deepEqual(d, { allow: false, reason: 'capture requires a recorded human approval' });
  assert.equal(checkMandate(base({ approvals: [approve] })).allow, true);
});
test('guard: provider approval row does not count; provider cannot capture', () => {
  assert.equal(checkMandate(base({ approvals: [{ decision: 'approve', user_id: 2, role: 'provider' }] })).allow, false);
  assert.equal(checkMandate(base({ actor: provider, approvals: [approve] })).allow, false);
  assert.equal(checkMandate(base({ approvals: [{ decision: 'approve', user_id: 2, role: 'reviewer' }] })).allow, false); // same user as provider
});
test('guard: reject row is not an approval; capture needs state verified', () => {
  assert.equal(checkMandate(base({ approvals: [{ decision: 'reject', user_id: 1, role: 'family' }] })).allow, false);
  assert.equal(checkMandate(base({ approvals: [approve], milestone: { id: M, state: 'proof_submitted', providerUserId: 2 } })).allow, false);
});
test('guard: void needs state rejected and a human rejection; reauthorize roles', () => {
  const rej = { decision: 'reject' as const, user_id: 1, role: 'family' };
  assert.equal(checkMandate(base({ type: 'void', approvals: [], milestone: { id: M, state: 'rejected', providerUserId: 2 } })).allow, false);
  assert.equal(checkMandate(base({ type: 'void', approvals: [rej], milestone: { id: M, state: 'rejected', providerUserId: 2 } })).allow, true);
  assert.equal(checkMandate(base({ type: 'void', approvals: [rej] })).allow, false); // state verified
  const sys: Actor = { userId: null, role: 'system', label: 'system' };
  assert.equal(checkMandate(base({ type: 'reauthorize', actor: sys, milestone: { id: M, state: 'authorized', providerUserId: 2 } })).allow, true);
  assert.equal(checkMandate(base({ type: 'reauthorize', actor: family, milestone: { id: M, state: 'authorized', providerUserId: 2 } })).allow, false);
});

// --- bypass attempts through GuardedPayPal never reach PayPal ---
function harness(approvalRows: any[]) {
  const calls: string[] = [];
  const f = (async (u: string, init: any) => {
    if (String(u).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    calls.push(`${init.method} ${u}`); return new Response('{}', { status: 201 });
  }) as typeof fetch;
  const client = new PayPalClient({ base: 'https://api-m.sandbox.paypal.com', clientId: 'a', clientSecret: 'b' }, f);
  const gp = new GuardedPayPal(client, { query: (async () => ({ rows: approvalRows })) as any });
  return { calls, gp };
}
const ctx = (o: any = {}) => ({ actor: family, milestone: { id: M, state: 'verified' as const, providerUserId: 2 }, amount: '10.00', attempt: 1, ...o });

test('BYPASS: capture without approval row is denied and PayPal is never called', async () => {
  const { calls, gp } = harness([]);
  await assert.rejects(() => gp.capture(ctx(), 'AUTH1', 'USD'), (e: any) => e instanceof GuardDenied && /approval/.test(e.reason));
  assert.equal(calls.length, 0);
});
test('BYPASS: provider-forged approval, wrong state, zero amount, provider actor all denied', async () => {
  let h = harness([{ decision: 'approve', user_id: 2, role: 'provider' }]);
  await assert.rejects(() => h.gp.capture(ctx(), 'A', 'USD'), GuardDenied);
  h = harness([approve]);
  await assert.rejects(() => h.gp.capture(ctx({ milestone: { id: M, state: 'proof_submitted', providerUserId: 2 } }), 'A', 'USD'), GuardDenied);
  await assert.rejects(() => h.gp.capture(ctx({ amount: '0' }), 'A', 'USD'), GuardDenied);
  await assert.rejects(() => h.gp.capture(ctx({ actor: provider }), 'A', 'USD'), GuardDenied);
  await assert.rejects(() => h.gp.void(ctx(), 'A'), GuardDenied); // no rejection row / wrong state
  assert.equal(h.calls.length, 0);
});
test('with a valid approval the capture goes through with the deterministic request id', async () => {
  const { calls, gp } = harness([approve]);
  const r = await gp.capture(ctx(), 'AUTH1', 'USD');
  assert.equal(r.status, 201); assert.equal(calls.length, 1); assert.match(calls[0], /authorizations\/AUTH1\/capture/);
});
test('client refuses live PayPal host', () => {
  assert.throws(() => new PayPalClient({ base: 'https://api-m.paypal.com', clientId: 'a', clientSecret: 'b' }));
});
test('STATIC: money methods are only referenced from guard.ts and paypal.ts', () => {
  const re = /\.(createOrder|authorizeOrder|captureAuthorization|voidAuthorization|reauthorizeAuthorization)\(/;
  const bad: string[] = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url))) {
    if (['guard.ts', 'paypal.ts'].includes(f) || !f.endsWith('.ts')) continue;
    if (re.test(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8'))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
