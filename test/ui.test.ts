import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

const dir = fileURLToPath(new URL('../public', import.meta.url));
async function withApp<T>(ui: { dir: string; paypalClientId?: string } | undefined, fn: (base: string) => Promise<T>) {
  const srv = createApp({ store: new MemoryStore(), ui }).listen(0);
  try { return await fn(`http://127.0.0.1:${(srv.address() as any).port}`); } finally { srv.close(); }
}

test('UI: index, script and style are served with a strict CSP; the API stays plain JSON', async () => {
  await withApp({ dir, paypalClientId: 'FAKE-CLIENT-ID' }, async (b) => {
    const idx = await fetch(b + '/');
    assert.equal(idx.status, 200);
    const csp = idx.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self' https:\/\/\*\.paypal\.com/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/script-src[^;]*unsafe/.test(csp));
    assert.match(await idx.text(), /Guardian Pay/);
    assert.equal((await fetch(b + '/app.js')).status, 200); assert.equal((await fetch(b + '/style.css')).status, 200);
    assert.equal((await fetch(b + '/samples/good_receipt_notice.png')).status, 200);
    assert.equal((await fetch(b + '/health')).headers.get('content-security-policy'), null);
  });
});

test('UI: /api/config exposes only the (public) sandbox client id and the SDK settings', async () => {
  await withApp({ dir, paypalClientId: 'FAKE-CLIENT-ID' }, async (b) => {
    const c = await (await fetch(b + '/api/config')).json() as any;
    assert.deepEqual(Object.keys(c).sort(), ['currency', 'intent', 'paypal_client_id', 'paypal_env']);
    assert.equal(c.intent, 'authorize'); assert.equal(c.paypal_env, 'sandbox'); assert.equal(c.paypal_client_id, 'FAKE-CLIENT-ID');
  });
  await withApp(undefined, async (b) => { assert.equal((await fetch(b + '/api/config')).status, 404); });
});

test('UI copy: never says escrow or guarantee; shows the disclaimer; EN and ES both present; no raw innerHTML of data', () => {
  const files = readdirSync(dir).filter(f => /\.(html|js|css)$/.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) { const s = readFileSync(`${dir}/${f}`, 'utf8'); assert.ok(!/escrow/i.test(s), `${f} says escrow`); assert.ok(!/guarantee/i.test(s), `${f} says guarantee`); }
  const js = readFileSync(`${dir}/app.js`, 'utf8');
  assert.match(js, /not a legal determination/i); assert.match(js, /no es una determinación legal/i); assert.match(js, /SIMULATED/); assert.match(js, /SIMULADO/);
  assert.deepEqual((js.match(/\.innerHTML/g) ?? []).length, 1, 'only the static disclaimer may use innerHTML');
});
