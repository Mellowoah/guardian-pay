import express from 'express';
import type { Db } from './db.js';
import { GuardDenied } from './guard.js';
import type { Service } from './services.js';
import { HttpError } from './repo.js';
import { IllegalTransition } from './state.js';
import { userAuth, adminAuth, type AuthConfig } from './auth.js';
import { type Actor } from './guard.js';
import { lifecycleTick } from './lifecycle.js';
import { reconcilePending } from './reconcile.js';
import type { GuardedPayPal } from './guard.js';
import type { PayeeService } from './payee/service.js';

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

/** tiny fixed-window per-IP limiter for the public endpoint (in-memory; fine for one instance) */
function rateLimit(max: number, windowMs: number): express.RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req, res, next) => {
    const now = Date.now(); const k = req.ip ?? 'x'; let h = hits.get(k);
    if (!h || now >= h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); if (hits.size > 5000) for (const [kk, v] of hits) if (now >= v.reset) hits.delete(kk); }
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000))).status(429).json({ error: 'rate_limited' }); return; }
    next();
  };
}

/** PUBLIC (no login): anyone — including a family before they pay — can see whether a provider's payee checks pass. Read-only, rate limited, no personal data beyond the public registry fields. */
export function buildPublicApi(payee: PayeeService): express.Router {
  const r = express.Router();
  r.get('/:providerId', rateLimit(60, 60_000), wrap(async (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.providerId)) throw new HttpError(404, 'not_found', 'provider not found');
    res.set('Cache-Control', 'no-store').json(await payee.publicVerify(Number(req.params.providerId)));
  }));
  r.use(errorHandler);
  return r;
}

export function buildApi(db: Db, svc: Service, auth: AuthConfig, payee: PayeeService): express.Router {
  const r = express.Router();
  r.use(wrap(userAuth(db, auth)));
  const a = (req: express.Request) => req.actor!;
  const only = (...roles: Actor['role'][]): express.RequestHandler => (req, _res, next) => { if (!roles.includes(a(req).role)) throw new HttpError(403, 'forbidden', `role ${a(req).role} may not use this route`); next(); };
  // proof upload carries a base64 image (<= 5 MB): larger body limit on this route only, and only after auth
  r.post('/milestones/:id/proof', only('provider'), express.json({ limit: '8mb' }), wrap(async (req, res) => { res.json(await svc.submitProof(a(req), req.params.id, req.body)); }));
  r.use(express.json({ limit: '100kb' }));

  r.get('/me', (req, res) => { res.json(a(req)); });
  r.get('/cases', wrap(async (req, res) => {
    const x = a(req);
    const rows = (await db.query(
      `SELECT c.id, c.title, c.currency, c.created_at FROM cases c JOIN providers p ON p.id = c.provider_id
        WHERE ($1 = 'reviewer') OR ($1 = 'provider' AND p.user_id = $2) OR ($1 = 'family' AND c.family_user_id = $2) ORDER BY c.created_at DESC LIMIT 100`, [x.role, x.userId])).rows;
    res.json({ cases: rows });
  }));
  r.post('/cases', only('provider'), wrap(async (req, res) => { res.status(201).json(await svc.createCase(a(req), req.body)); }));
  r.get('/cases/:id', wrap(async (req, res) => { res.json(await svc.getCase(a(req), req.params.id)); }));
  r.get('/cases/:id/payee', wrap(async (req, res) => { res.json(await svc.casePayee(a(req), req.params.id)); }));
  r.post('/cases/:id/payee-change', only('provider'), wrap(async (req, res) => { res.status(201).json(await payee.requestChange(a(req), req.params.id, req.body?.new_merchant_id)); }));
  r.post('/cases/:id/payee-change/approve', only('family'), wrap(async (req, res) => { res.json(await payee.approveChange(a(req), req.params.id)); }));
  r.post('/cases/:id/payee-change/cancel', only('provider', 'family'), wrap(async (req, res) => { res.json(await payee.cancelChange(a(req), req.params.id)); }));
  r.post('/cases/:id/payee-change/apply', only('provider', 'family'), wrap(async (req, res) => { res.json(await payee.applyChange(a(req), req.params.id)); }));
  r.post('/provider/onboarding', only('provider'), wrap(async (req, res) => { res.status(201).json(await payee.startOnboarding(a(req))); }));
  r.post('/verify-payee', only('provider', 'reviewer'), wrap(async (req, res) => { res.json(await payee.verifyMerchant(a(req), Number(req.body?.provider_id), req.body?.merchant_id)); }));
  r.get('/cases/:id/audit', wrap(async (req, res) => { res.json(await svc.getAudit(a(req), req.params.id)); }));
  r.post('/milestones/:id/order', only('family'), wrap(async (req, res) => { res.status(201).json(await svc.openOrder(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/authorize', only('family'), wrap(async (req, res) => { res.json(await svc.authorizeWallet(a(req), req.params.id)); }));
  r.get('/milestones/:id/proof', wrap(async (req, res) => { res.json(await svc.currentProof(a(req), req.params.id)); }));
  r.get('/milestones/:id/proof/image', only('family', 'reviewer'), wrap(async (req, res) => {
    const img = await svc.proofImage(a(req), req.params.id);
    // the bytes are untrusted provider input: served inert (never sniffed, never rendered as HTML, never cached)
    res.set({ 'Content-Type': img.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline; filename="proof"', ETag: `"${img.sha256}"`, 'X-Proof-Sha256': img.sha256 });
    res.send(img.bytes);
  }));
  r.get('/milestones/:id/verification', wrap(async (req, res) => { res.json(await svc.verification(a(req), req.params.id)); }));
  r.post('/milestones/:id/verify', only('reviewer'), wrap(async (req, res) => { res.json(await svc.verifyProof(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/approve', only('family'), wrap(async (req, res) => { res.json(await svc.approve(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/reject', only('family', 'reviewer'), wrap(async (req, res) => { res.json(await svc.reject(a(req), req.params.id, req.body)); }));

  r.use((_q, res) => { res.status(404).json({ error: 'not_found' }); });
  r.use(errorHandler);
  return r;
}

const errorHandler = ((err, _req, res, _next) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.code, message: err.message, ...err.extra }); return; }
    if (err instanceof GuardDenied) { res.status(403).json({ error: 'guard_denied', message: err.reason }); return; }
    if (err instanceof IllegalTransition) { res.status(409).json({ error: 'illegal_transition', message: err.message }); return; }
    if (err?.type === 'entity.too.large') { res.status(413).json({ error: 'too_large' }); return; }
    if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'bad_json' }); return; }
    console.error('api error', err?.message ?? err); res.status(500).json({ error: 'internal' });
}) as express.ErrorRequestHandler;


/** Admin routes (demo clock per case, run jobs, revoke token). Only mounted when ENABLE_ADMIN_ROUTES=true, and always behind the admin token. */
export function buildAdminApi(db: Db, svc: Service, guarded: GuardedPayPal, auth: AuthConfig): express.Router {
  const r = express.Router();
  r.use(adminAuth(auth), express.json({ limit: '10kb' }));
  const a = (req: express.Request) => req.actor!;
  r.get('/cases/:id/clock', wrap(async (req, res) => { res.json(await svc.getCaseClock(req.params.id)); }));
  r.post('/cases/:id/clock', wrap(async (req, res) => { res.json(await svc.setCaseClock(a(req), req.params.id, req.body?.offset_days, req.body?.reason)); }));
  r.post('/run-jobs', wrap(async (req, res) => {
    const caseId = typeof req.body?.case_id === 'string' ? req.body.case_id : undefined;
    const reconciled = await reconcilePending(db);
    res.json({ lifecycle: await lifecycleTick(db, guarded, { caseId }), reconciled: reconciled.length });
  }));
  r.post('/users/:username/revoke-token', wrap(async (req, res) => { res.json(await svc.revokeUserToken(a(req), req.params.username)); }));
  r.use((_q, res) => { res.status(404).json({ error: 'not_found' }); });
  r.use(errorHandler);
  return r;
}
