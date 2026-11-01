import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLifecycle } from '../src/lifecycle.js';
import { decide } from '../src/reconcile.js';
import { DAY, addDays } from '../src/clock.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const base = { authorized_at: t0, honor_until: addDays(t0, 3), expires_at: addDays(t0, 29), reauth_count: 0, warned_at: null, state: 'proof_submitted' as const };
const at = (d: number, over: object = {}) => planLifecycle({ ...base, now: new Date(t0.getTime() + d * DAY), ...over });

test('lifecycle plan: nothing before day 3; reauthorize once from day 3; warn from day 25; expire at day 29', () => {
  assert.deepEqual(at(2.9), []); assert.deepEqual(at(3), ['reauthorize']); assert.deepEqual(at(10), ['reauthorize']);
  assert.deepEqual(at(10, { reauth_count: 1 }), []);
  assert.deepEqual(at(24.9, { reauth_count: 1 }), []); assert.deepEqual(at(25, { reauth_count: 1 }), ['warn']);
  assert.deepEqual(at(26), ['warn', 'reauthorize']); assert.deepEqual(at(26, { warned_at: t0, reauth_count: 1 }), []);
  assert.deepEqual(at(29), ['expire']); assert.deepEqual(at(40, { reauth_count: 1 }), ['expire']);
});
test('lifecycle plan ignores milestones that are no longer holding funds', () => {
  for (const s of ['created', 'rejected', 'captured', 'voided', 'expired'] as const) assert.deepEqual(at(30, { state: s }), []);
});

const P = { capture_id: 'CAP1', original_authorization_id: 'A1', current_authorization_id: 'A1', reauth_count: 0, expires_at: addDays(t0, 29), status: 'captured' };
test('reconcile decide: confirm / apply / override / flag / ignore', () => {
  assert.equal(decide('PAYMENT.CAPTURE.COMPLETED', 'CAP1', { state: 'captured' }, P, true, t0).kind, 'confirm');
  assert.equal(decide('PAYMENT.CAPTURE.COMPLETED', 'CAP1', { state: 'verified' }, { ...P, capture_id: null }, true, t0).kind, 'apply');
  const rogue = decide('PAYMENT.CAPTURE.COMPLETED', 'CAPX', { state: 'authorized' }, P, false, t0);
  assert.equal(rogue.kind, 'override'); assert.match(rogue.note, /NO recorded human approval/);
  const dec = decide('PAYMENT.CAPTURE.DENIED', 'CAP1', { state: 'captured' }, P, true, t0);
  assert.deepEqual([dec.kind, (dec as any).to], ['override', 'verified']);
  assert.equal(decide('PAYMENT.CAPTURE.DECLINED', 'CAP1', { state: 'voided' }, P, true, t0).kind, 'ignore');
  assert.equal(decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'voided' }, P, true, t0).kind, 'confirm');
  assert.equal(decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'rejected' }, P, true, t0).kind, 'apply');
  assert.deepEqual((decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'authorized' }, P, true, t0) as any).to, 'voided');
  assert.deepEqual((decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'authorized' }, P, true, addDays(t0, 30)) as any).to, 'expired');
  assert.equal(decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'proof_submitted' }, { ...P, reauth_count: 1, current_authorization_id: 'A2' }, true, t0).kind, 'ignore');
  assert.equal(decide('PAYMENT.AUTHORIZATION.VOIDED', 'A1', { state: 'captured' }, P, true, t0).kind, 'flag');
});
