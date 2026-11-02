import express from 'express';
import type { EventStore } from './store.js';
import type { Headers } from './paypal.js';

export interface AppDeps {
  store: EventStore;
  /** returns PayPal verification_status ("SUCCESS" | "FAILURE" | ...); undefined verifier = webhook id not configured */
  verify?: (headers: Headers, rawBody: string) => Promise<string>;
  /** called after a NEW verified event is stored (reconciliation); failures never fail the webhook response */
  onEvent?: (eventId: string, eventType: string) => Promise<void>;
  /** mounts the /api router (needs a database) */
  api?: import('express').Router;
  /** admin surface (only when ENABLE_ADMIN_ROUTES=true): `gate` is the admin-token check; `router` is mounted at /api/admin */
  admin?: { gate: import('express').RequestHandler; router?: import('express').Router };
}

export function createApp({ store, verify, onEvent, api, admin }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

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
    if (inserted && onEvent) { try { await onEvent(event.id, event.event_type); } catch (e) { console.error('reconcile failed (will retry)', event.id, (e as Error).message); } }
    res.status(200).json({ received: true, duplicate: !inserted });
  });

  // Debug + admin: NOT mounted unless ENABLE_ADMIN_ROUTES=true, and then only behind the admin token. Read-only: type, id, verified, received_at (no payloads).
  if (admin) {
    app.get('/api/debug/webhooks', admin.gate, async (_req, res) => {
      const rows = await store.recent(50);
      res.json({ store: store.kind, events: rows.map(r => ({ type: r.event_type, id: r.paypal_event_id, verified: r.verified, received_at: r.received_at })) });
    });
    if (admin.router) app.use('/api/admin', admin.router);
  }
  if (api) app.use('/api', api);
  app.get('/paypal/return', (_req, res) => { res.type('text').send('Approved in the PayPal sandbox. You can close this tab and call POST /api/milestones/:id/authorize.'); });
  app.get('/paypal/cancel', (_req, res) => { res.type('text').send('Cancelled in the PayPal sandbox.'); });
  return app;
}
