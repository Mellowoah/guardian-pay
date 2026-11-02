import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, TRANSITIONS, canTransition, assertTransition, IllegalTransition, type MilestoneState } from '../src/state.js';
import { requestId } from '../src/idempotency.js';

test('happy path transitions are legal', () => {
  const path: MilestoneState[] = ['created', 'authorized', 'reauthorized', 'proof_submitted', 'verified', 'captured'];
  for (let i = 0; i < path.length - 1; i++) assert.ok(canTransition(path[i], path[i + 1]), `${path[i]}->${path[i + 1]}`);
  assert.ok(canTransition('authorized', 'proof_submitted')); // reauth is optional
});
test('reject path and expiry are legal', () => {
  assert.ok(canTransition('proof_submitted', 'rejected')); assert.ok(canTransition('rejected', 'voided'));
  assert.ok(canTransition('authorized', 'expired')); assert.ok(canTransition('reauthorized', 'expired'));
});
test('every non-listed transition is illegal', () => {
  for (const a of STATES) for (const b of STATES) {
    const legal = TRANSITIONS[a].includes(b);
    assert.equal(canTransition(a, b), legal);
    if (!legal) assert.throws(() => assertTransition(a, b), IllegalTransition);
  }
});
test('key illegal jumps', () => {
  for (const [a, b] of [['created', 'captured'], ['authorized', 'captured'], ['proof_submitted', 'captured'], ['rejected', 'captured'],
    ['captured', 'rejected'], ['captured', 'voided'], ['voided', 'authorized'], ['expired', 'captured'], ['created', 'voided']] as const)
    assert.throws(() => assertTransition(a, b), IllegalTransition, `${a}->${b}`);
});
test('terminal states have no exits', () => {
  for (const s of ['captured', 'voided', 'expired'] as const) assert.equal(TRANSITIONS[s].length, 0);
});

const M = '123e4567-e89b-12d3-a456-426614174000';
test('requestId is deterministic and distinct per action/attempt', () => {
  assert.equal(requestId(M, 'capture', 1), requestId(M, 'capture', 1));
  assert.notEqual(requestId(M, 'capture', 1), requestId(M, 'capture', 2));
  assert.notEqual(requestId(M, 'capture', 1), requestId(M, 'void', 1));
  assert.ok(requestId(M, 'reauthorize', 12).length <= 108);
});
test('requestId rejects bad input', () => {
  assert.throws(() => requestId('nope', 'capture', 1));
  assert.throws(() => requestId(M, 'capture', 0));
});

test('the family may reject after the reviewer verified (verified -> rejected -> voided)', () => {
  assertTransition('verified', 'rejected'); assertTransition('rejected', 'voided');
});
