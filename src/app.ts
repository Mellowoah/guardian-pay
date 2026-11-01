import express from 'express';
import type { EventStore } from './store.js';
import type { Headers } from './paypal.js';

export interface AppDeps {
  store: EventStore;
  /** returns PayPal verification_status ("SUCCESS" | "FAILURE" | ...); undefined verifier = webhook id not configured */
  verify?: (headers: Headers, rawBody: string) => Promise<string>;
}

export function createApp({ store, verify }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => { res.json({ ok: true, store: store.kind }); });

  app.post('/webhooks/paypal', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!verify) { res.status(503).json({ error: 'PAYPAL_WEBHOOK_ID not configured' }); return; }
    const raw = typeof req.body === 'string' ? req.body : '';
    let event: { id?: string; event_type?: string };
    try { event = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid json' }); return; }
    if (!event.id || !event.event_type) { res.status(400).json({ error: 'missing id/event_type' }); return; }
    let status: string;
    try { status = await verify(req.headers, raw); }
    catch (e) { console.error('verify error', (e as Error).message); res.status(502).json({ error: 'verification unavailable', reason: (e as Error).message }); return; }
    console.log(`webhook ${event.event_type} ${event.id} verification_status=${status}`);
    if (status !== 'SUCCESS') { res.status(400).json({ error: 'signature verification failed', verification_status: status }); return; }
    const inserted = await store.insert({ id: event.id, type: event.event_type, verified: true, payload: event });
    console.log(`webhook ${event.id} ${inserted ? 'stored' : 'duplicate (ignored)'}`);
    res.status(200).json({ received: true, duplicate: !inserted });
  });

  // Read-only: type, id, verified, received_at only (no payloads)
  app.get('/api/debug/webhooks', async (_req, res) => {
    const rows = await store.recent(50);
    res.json({ store: store.kind, events: rows.map(r => ({ type: r.event_type, id: r.paypal_event_id, verified: r.verified, received_at: r.received_at })) });
  });
  return app;
}
