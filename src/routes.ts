import express from 'express';
import type { Db } from './db.js';
import { GuardDenied, type Actor, type Role } from './guard.js';
import { Service } from './services.js';
import { HttpError } from './repo.js';
import { IllegalTransition } from './state.js';
import { clock } from './clock.js';
import { lifecycleTick } from './lifecycle.js';
import { reconcilePending } from './reconcile.js';
import type { GuardedPayPal } from './guard.js';

declare module 'express-serve-static-core' { interface Request { actor?: Actor } }

/** Demo auth: `x-demo-user: <username>` (or `Authorization: Bearer demo-<username>`) against the seeded users table. Synthetic users only. */
export function demoAuth(db: Db): express.RequestHandler {
  return async (req, res, next) => {
    const bearer = /^Bearer demo-(.+)$/.exec(req.header('authorization') ?? '')?.[1];
    const name = (req.header('x-demo-user') ?? bearer ?? '').trim();
    if (!name) { res.status(401).json({ error: 'unauthenticated', hint: 'send x-demo-user: family_demo | provider_demo | provider_two | reviewer_demo' }); return; }
    const u = (await db.query('SELECT id, username, role FROM users WHERE username = $1', [name])).rows[0];
    if (!u) { res.status(401).json({ error: 'unknown demo user' }); return; }
    req.actor = { userId: u.id, role: u.role as Role, label: u.username };
    next();
  };
}

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

export function buildApi(db: Db, svc: Service, guarded: GuardedPayPal): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '100kb' }));
  r.use(wrap(demoAuth(db)));
  const a = (req: express.Request) => req.actor!;

  r.get('/me', (req, res) => { res.json(a(req)); });
  r.get('/cases', wrap(async (req, res) => {
    const x = a(req);
    const rows = (await db.query(
      `SELECT c.id, c.title, c.currency, c.created_at FROM cases c JOIN providers p ON p.id = c.provider_id
        WHERE ($1 = 'reviewer') OR ($1 = 'provider' AND p.user_id = $2) OR ($1 = 'family' AND c.family_user_id = $2) ORDER BY c.created_at DESC LIMIT 100`, [x.role, x.userId])).rows;
    res.json({ cases: rows });
  }));
  r.post('/cases', wrap(async (req, res) => { res.status(201).json(await svc.createCase(a(req), req.body)); }));
  r.get('/cases/:id', wrap(async (req, res) => { res.json(await svc.getCase(a(req), req.params.id)); }));
  r.get('/cases/:id/audit', wrap(async (req, res) => { res.json(await svc.getAudit(a(req), req.params.id)); }));
  r.post('/milestones/:id/order', wrap(async (req, res) => { res.status(201).json(await svc.openOrder(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/authorize', wrap(async (req, res) => { res.json(await svc.authorizeWallet(a(req), req.params.id)); }));
  r.post('/milestones/:id/proof', wrap(async (req, res) => { res.json(await svc.submitProof(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/verify', wrap(async (req, res) => { res.json(await svc.verifyProof(a(req), req.params.id, req.body)); }));
  r.post('/milestones/:id/approve', wrap(async (req, res) => { res.json(await svc.approve(a(req), req.params.id)); }));
  r.post('/milestones/:id/reject', wrap(async (req, res) => { res.json(await svc.reject(a(req), req.params.id, req.body)); }));

  // reviewer-only demo admin: fake clock + run background jobs now
  const reviewerOnly: express.RequestHandler = (req, _res, next) => { if (a(req).role !== 'reviewer') throw new HttpError(403, 'forbidden', 'reviewer only'); next(); };
  r.get('/admin/clock', reviewerOnly, (_q, res) => { res.json({ offset_days: clock.getOffsetDays(), now: clock.now().toISOString() }); });
  r.post('/admin/clock', reviewerOnly, (req, res) => {
    const d = Number(req.body?.offset_days);
    if (!Number.isFinite(d) || d < 0 || d > 60) throw new HttpError(400, 'bad_request', 'offset_days must be 0-60');
    clock.setOffsetDays(d); res.json({ offset_days: clock.getOffsetDays(), now: clock.now().toISOString() });
  });
  r.post('/admin/run-jobs', reviewerOnly, wrap(async (req, res) => {
    const caseId = typeof req.body?.case_id === 'string' ? req.body.case_id : undefined;
    const reconciled = await reconcilePending(db);
    res.json({ lifecycle: await lifecycleTick(db, guarded, { caseId }), reconciled: reconciled.length, clock: clock.now().toISOString() });
  }));

  r.use((_q, res) => { res.status(404).json({ error: 'not_found' }); });
  r.use(((err, _req, res, _next) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.code, message: err.message, ...err.extra }); return; }
    if (err instanceof GuardDenied) { res.status(403).json({ error: 'guard_denied', message: err.reason }); return; }
    if (err instanceof IllegalTransition) { res.status(409).json({ error: 'illegal_transition', message: err.message }); return; }
    if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'bad_json' }); return; }
    console.error('api error', err?.message ?? err); res.status(500).json({ error: 'internal' });
  }) as express.ErrorRequestHandler);
  return r;
}
