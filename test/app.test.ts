import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { assertSandbox, verifyWebhookSignature } from '../src/paypal.js';

async function serve(verify?: (h: any, raw: string) => Promise<string>) {
  const store = new MemoryStore();
  const server = createApp({ store, verify }).listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, store, close: () => server.close() };
}
const post = (url: string, body: unknown) => fetch(url + '/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ev = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { secret: 'x' } };

test('health', async () => {
  const s = await serve(); const r = await fetch(s.url + '/health');
  assert.equal(r.status, 200); assert.equal((await r.json() as any).ok, true); s.close();
});
test('503 when webhook id not configured', async () => {
  const s = await serve(); assert.equal((await post(s.url, ev)).status, 503); s.close();
});
test('rejects failed verification and stores nothing', async () => {
  const s = await serve(async () => 'FAILURE'); const r = await post(s.url, ev);
  assert.equal(r.status, 400); assert.equal((await s.store.recent(10)).length, 0); s.close();
});
test('dedupes by event id and debug endpoint hides payloads', async () => {
  const s = await serve(async () => 'SUCCESS');
  assert.equal(((await (await post(s.url, ev)).json()) as any).duplicate, false);
  assert.equal(((await (await post(s.url, ev)).json()) as any).duplicate, true);
  const d = await (await fetch(s.url + '/api/debug/webhooks')).json() as any;
  assert.equal(d.events.length, 1);
  assert.deepEqual(Object.keys(d.events[0]).sort(), ['id', 'received_at', 'type', 'verified']);
  assert.equal(d.events[0].verified, true); s.close();
});
test('400 on invalid json', async () => {
  const s = await serve(async () => 'SUCCESS');
  const r = await fetch(s.url + '/webhooks/paypal', { method: 'POST', body: 'nope' }); assert.equal(r.status, 400); s.close();
});
test('assertSandbox refuses live host', () => {
  assert.throws(() => assertSandbox('https://api-m.paypal.com'));
  assertSandbox('https://api-m.sandbox.paypal.com');
});
test('verifyWebhookSignature splices raw body and returns status', async () => {
  let sent = '';
  const f = (async (u: string, init: any) => {
    if (u.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    sent = init.body; return new Response(JSON.stringify({ verification_status: 'SUCCESS' }));
  }) as any;
  const raw = '{"id":"WH-9","amount":1.10}';
  const st = await verifyWebhookSignature({ base: 'https://x', clientId: 'a', clientSecret: 'b', webhookId: 'W' }, { 'paypal-transmission-id': 'tid' }, raw, f);
  assert.equal(st, 'SUCCESS'); assert.ok(sent.includes('"webhook_event":' + raw)); assert.equal(JSON.parse(sent).webhook_id, 'W');
});
