import { createApp } from './app.js';
import { MemoryStore, PgStore, type EventStore } from './store.js';
import { assertSandbox, verifyWebhookSignature, PayPalClient, type PayPalConfig } from './paypal.js';
import { connect, type Db } from './db.js';
import { migrate } from './migrations.js';
import { GuardedPayPal } from './guard.js';
import { Service } from './services.js';
import { buildApi } from './routes.js';
import { lifecycleTick } from './lifecycle.js';
import { makeExtractor } from './verify/extraction.js';
import { Verifier } from './verify/verifier.js';
import { reconcileEvent, reconcilePending } from './reconcile.js';

const base = process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
assertSandbox(base);
const port = Number(process.env.PORT ?? 3000);
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PAYPAL_WEBHOOK_ID: webhookId } = process.env;

let store: EventStore = new MemoryStore();
let db: Db | undefined;
if (process.env.DATABASE_URL) {
  try {
    db = connect(process.env.DATABASE_URL);
    const applied = await migrate(db);
    console.log(`migrations: ${applied.length ? 'applied ' + applied.join(', ') : 'up to date'}`);
    store = new PgStore(db);
  } catch (e) { console.error('Postgres unavailable, falling back to in-memory store:', (e as Error).message); db = undefined; }
}

let verify;
if (clientId && clientSecret && webhookId) {
  const cfg: PayPalConfig = { base, clientId, clientSecret, webhookId };
  verify = (h: Parameters<typeof verifyWebhookSignature>[1], raw: string) => verifyWebhookSignature(cfg, h, raw);
} else console.warn('PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID not all set: /webhooks/paypal returns 503');

let verifier: Verifier | undefined;
let api: import("express").Router | undefined, onEvent: ((id: string) => Promise<void>) | undefined, guarded: GuardedPayPal | undefined;
if (db && clientId && clientSecret) {
  guarded = new GuardedPayPal(new PayPalClient({ base, clientId, clientSecret }), db);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`;
  const extractor = makeExtractor(process.env);
  verifier = new Verifier(db, extractor);
  console.log(`AI proof check: extractor=${extractor.name} (advisory only; a human must still approve)`);
  api = buildApi(db, new Service(db, guarded, { publicBaseUrl, allowSandboxCard: true, verifier }), guarded);
  const d = db;
  onEvent = async (id: string) => { await reconcileEvent(d, id); };
} else console.warn('API disabled: needs DATABASE_URL and PayPal credentials');

createApp({ store, verify, onEvent, api }).listen(port, () => console.log(`guardian-pay listening on ${port} (store=${store.kind}, api=${api ? 'on' : 'off'}, paypal=${new URL(base).hostname})`));

// In-process job every 15 minutes: reauthorize after day 3 (once), warn at day 25, expire at day 29, re-run unprocessed webhooks.
if (db && guarded) {
  const d = db, g = guarded; let running = false;
  const run = async () => {
    if (running) return; running = true;
    try {
      const lock = await d.pool.connect();
      try {
        if (!(await lock.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0].ok) return; // another instance is running it
        await verifier?.resumeStale();
        const rec = await reconcilePending(d); const t = await lifecycleTick(d, g);
        if (t.checked || rec.length) console.log('jobs', JSON.stringify({ ...t, reconciled: rec.length }));
        await lock.query('SELECT pg_advisory_unlock(727002)');
      } finally { lock.release(); }
    } catch (e) { console.error('job error', (e as Error).message); } finally { running = false; }
  };
  setInterval(run, 15 * 60_000).unref();
  setTimeout(run, 20_000).unref();
}
