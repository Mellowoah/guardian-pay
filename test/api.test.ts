import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TEST_URL, setup, type Env } from './helpers.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { buildApi } from '../src/routes.js';

const opts = { skip: TEST_URL ? false : 'DATABASE_URL_TEST not set' };
let e: Env; let base = ''; let server: ReturnType<ReturnType<typeof createApp>['listen']>;
before(async () => { if (!TEST_URL) return; e = await setup(); server = createApp({ store: new MemoryStore(), api: buildApi(e.db, e.svc, e.guarded) }).listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { if (!TEST_URL) return; server.close(); await e.close(); });
const call = async (user: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-demo-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};

test('API: auth, roles, happy path and audit over HTTP', opts, async () => {
  assert.equal((await call(null, 'GET', '/api/cases')).status, 401);
  assert.equal((await call('nobody', 'GET', '/api/cases')).status, 401);
  assert.equal((await call('family_demo', 'POST', '/api/cases', { title: 't', milestones: [{ title: 'a', amount: '5.00' }] })).status, 403);
  assert.equal((await call('provider_demo', 'POST', '/api/cases', { title: 't', milestones: [{ title: 'a', amount: '0' }] })).status, 400);
  const c = await call('provider_demo', 'POST', '/api/cases', { title: 'Roof repair (synthetic)', milestones: [{ title: 'Deposit', amount: '12.50' }] });
  assert.equal(c.status, 201); const id = c.json.milestones[0].id;
  assert.equal((await call('provider_two', 'GET', `/api/cases/${c.json.id}`)).status, 403); // providers see only their own
  assert.equal((await call('family_demo', 'POST', `/api/milestones/${id}/order`, { payment_source: 'card' })).status, 201);
  assert.equal((await call('provider_demo', 'POST', `/api/milestones/${id}/proof`, { note: 'photos' })).status, 200);
  assert.equal((await call('provider_demo', 'POST', `/api/milestones/${id}/approve`)).status, 403);
  assert.equal((await call('family_demo', 'POST', `/api/milestones/${id}/approve`)).status, 409);
  assert.equal((await call('reviewer_demo', 'POST', `/api/milestones/${id}/verify`, {})).status, 200);
  const [a, b] = await Promise.all([call('family_demo', 'POST', `/api/milestones/${id}/approve`), call('family_demo', 'POST', `/api/milestones/${id}/approve`)]);
  assert.deepEqual([a.status, b.status], [200, 200]); assert.equal(a.json.payment.capture_id, b.json.payment.capture_id);
  assert.equal(e.fake.realCaptures, 1);
  const au = await call('family_demo', 'GET', `/api/cases/${c.json.id}/audit`);
  assert.equal(au.status, 200); assert.ok(au.json.count >= 8);
  assert.equal((await call('provider_demo', 'POST', '/api/admin/clock', { offset_days: 5 })).status, 403);
});
