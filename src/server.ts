import { createApp } from './app.js';
import { MemoryStore, PgStore, type EventStore } from './store.js';
import { assertSandbox, verifyWebhookSignature, PayPalClient, type PayPalConfig } from './paypal.js';
import { connect, type Db } from './db.js';
import { migrate } from './migrations.js';
import { GuardedPayPal } from './guard.js';
import { Service } from './services.js';
import { buildApi, buildAdminApi, buildPublicApi } from './routes.js';
import { authConfigFromEnv, adminAuth } from './auth.js';
import { lifecycleTick } from './lifecycle.js';
import { makeExtractor } from './verify/extraction.js';
import { Verifier } from './verify/verifier.js';
import { reconcileEvent, reconcilePending } from './reconcile.js';
import { PayeeService } from './payee/service.js';
import { LivePayPalOnboarding, SimulatedOnboarding } from './payee/onboarding.js';
import { PractitionerRegistry } from './payee/registry.js';

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

const auth = authConfigFromEnv(process.env);
let verifier: Verifier | undefined;
let admin: { gate: import('express').RequestHandler; router?: import('express').Router } | undefined;
let publicApi: import('express').Router | undefined, payeeSvc: PayeeService | undefined;
let api: import("express").Router | undefined, onEvent: ((id: string) => Promise<void>) | undefined, guarded: GuardedPayPal | undefined;
if (db && clientId && clientSecret) {
  const ppClient = new PayPalClient({ base, clientId, clientSecret });
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && v !== undefined && v !== '' ? n : d; };
  guarded = new GuardedPayPal(ppClient, db, { payeeMaxAgeHours: num(process.env.PAYEE_VERIFY_MAX_AGE_HOURS, 24) });
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`;
  const extractor = makeExtractor(process.env);
  verifier = new Verifier(db, extractor);
  console.log(`AI proof check: extractor=${extractor.name} (advisory only; a human must still approve)`);
  const onbMode = (process.env.PAYEE_ONBOARDING_MODE ?? 'auto').toLowerCase();
  const onboarding = onbMode === 'simulated' ? new SimulatedOnboarding() : new LivePayPalOnboarding(ppClient, process.env.PAYPAL_PARTNER_MERCHANT_ID || null);
  const registry = PractitionerRegistry.load();
  const m = registry.snapshot.manifest;
  payeeSvc = new PayeeService(db, onboarding, registry, { coolingHours: num(process.env.PAYEE_CHANGE_COOLING_HOURS, 72), refreshSeconds: num(process.env.PAYEE_REFRESH_SECONDS, 300), publicBaseUrl });
  console.log(`payee verification: onboarding=${onbMode === 'simulated' ? 'SIMULATED' : process.env.PAYPAL_PARTNER_MERCHANT_ID ? 'live status + real referrals (simulated fallback for demo merchants)' : 'real partner referrals; status SIMULATED (no PAYPAL_PARTNER_MERCHANT_ID)'}; EOIR snapshot roster ${m.roster_report_date}, discipline ${m.currently_disciplined.page_date}; attorney lookup SIMULATED`);
  const svc = new Service(db, guarded, { publicBaseUrl, allowSandboxCard: process.env.ALLOW_SANDBOX_CARD !== 'false', verifier, payee: payeeSvc });
  api = buildApi(db, svc, auth, payeeSvc); publicApi = buildPublicApi(payeeSvc);
  console.log(`auth: bearer tokens (key source ${auth.keySource}; ${Object.keys(auth.envTokens).length} per-user env tokens); admin routes ${auth.enableAdmin ? 'ENABLED (admin token required)' : 'disabled'}`);
  if (auth.keySource === 'none' && !Object.keys(auth.envTokens).length) console.warn('auth: no token key configured (set GP_TOKEN_SECRET or per-user GP_TOKEN_<USER>): every API call will return 401');
  if (auth.enableAdmin) admin = { gate: adminAuth(auth), router: buildAdminApi(db, svc, guarded, auth) };
  const d = db;
  const ps = payeeSvc; onEvent = async (id: string) => { await reconcileEvent(d, id, new Date(), ps); };
} else console.warn('API disabled: needs DATABASE_URL and PayPal credentials');

createApp({ store, verify, onEvent, api, admin, publicApi }).listen(port, () => console.log(`guardian-pay listening on ${port} (store=${store.kind}, api=${api ? 'on' : 'off'}, paypal=${new URL(base).hostname})`));

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
        const rec = await reconcilePending(d, new Date(), payeeSvc); const t = await lifecycleTick(d, g); const pc = await payeeSvc?.tickChanges();
        if (pc && (pc.applied || pc.blocked)) console.log('payee changes', JSON.stringify(pc));
        if (t.checked || rec.length) console.log('jobs', JSON.stringify({ ...t, reconciled: rec.length }));
        await lock.query('SELECT pg_advisory_unlock(727002)');
      } finally { lock.release(); }
    } catch (e) { console.error('job error', (e as Error).message); } finally { running = false; }
  };
  setInterval(run, 15 * 60_000).unref();
  setTimeout(run, 20_000).unref();
}
