import { createApp } from './app.js';
import { MemoryStore, PgStore, type EventStore } from './store.js';
import { assertSandbox, verifyWebhookSignature, type PayPalConfig } from './paypal.js';

const base = process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
assertSandbox(base);

let store: EventStore = new MemoryStore();
if (process.env.DATABASE_URL) {
  try { const pg = new PgStore(process.env.DATABASE_URL); await pg.init(); store = pg; }
  catch (e) { console.error('Postgres unavailable, falling back to in-memory store:', (e as Error).message); }
}

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PAYPAL_WEBHOOK_ID: webhookId } = process.env;
let verify;
if (clientId && clientSecret && webhookId) {
  const cfg: PayPalConfig = { base, clientId, clientSecret, webhookId };
  verify = (h: Parameters<typeof verifyWebhookSignature>[1], raw: string) => verifyWebhookSignature(cfg, h, raw);
} else console.warn('PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID not all set: /webhooks/paypal returns 503');

const port = Number(process.env.PORT ?? 3000);
createApp({ store, verify }).listen(port, () => console.log(`guardian-pay listening on ${port} (store=${store.kind}, paypal=${new URL(base).hostname})`));
