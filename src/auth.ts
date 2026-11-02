/**
 * Bearer-token auth (replaces the old x-demo-user header). Every API caller sends `Authorization: Bearer <token>`.
 *
 * Tokens are 256-bit HMAC values, one per user, never stored in the repo:
 *   1. GP_TOKEN_<USERNAME> env (e.g. GP_TOKEN_FAMILY_DEMO, >= 32 chars) wins if set (use `npm run seed-tokens` to mint random ones).
 *   2. otherwise HMAC-SHA256(key, "gp-token|<username>|<token_epoch>"), where key = GP_TOKEN_SECRET, or, if that is unset,
 *      a key derived from PAYPAL_CLIENT_SECRET (sandbox convenience; set GP_TOKEN_SECRET to use a dedicated key).
 * Bumping users.token_epoch (admin route) revokes a user's derived token. Admin routes need ENABLE_ADMIN_ROUTES=true AND the admin token.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Db } from './db.js';
import type { Actor, Role } from './guard.js';

export interface AuthConfig { key: string | null; envTokens: Record<string, string>; adminToken: string | null; enableAdmin: boolean; keySource: 'GP_TOKEN_SECRET' | 'PAYPAL_CLIENT_SECRET' | 'none' }

export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const envTokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^GP_TOKEN_([A-Z0-9_]+)$/.exec(k);
    if (m && m[1] !== 'SECRET' && v && v.length >= 32) envTokens[m[1].toLowerCase()] = v;
  }
  let key: string | null = null; let keySource: AuthConfig['keySource'] = 'none';
  if (env.GP_TOKEN_SECRET && env.GP_TOKEN_SECRET.length >= 16) { key = env.GP_TOKEN_SECRET; keySource = 'GP_TOKEN_SECRET'; }
  else if (env.PAYPAL_CLIENT_SECRET) { key = createHash('sha256').update('gp-token-key-v1|' + env.PAYPAL_CLIENT_SECRET).digest('hex'); keySource = 'PAYPAL_CLIENT_SECRET'; }
  const adminToken = env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 ? env.ADMIN_TOKEN : key ? deriveAdminToken(key) : null;
  return { key, envTokens, adminToken, enableAdmin: String(env.ENABLE_ADMIN_ROUTES ?? 'false').toLowerCase() === 'true', keySource };
}

const b64u = (b: Buffer) => b.toString('base64url');
export const deriveToken = (key: string, username: string, epoch = 0) => 'gp_' + b64u(createHmac('sha256', key).update(`gp-token|${username}|${epoch}`).digest());
export const deriveAdminToken = (key: string) => 'gpa_' + b64u(createHmac('sha256', key).update('gp-admin-token|v1').digest());
/** the token a given user must present (used by the server to check and by scripts/integration to call) */
export const tokenFor = (cfg: Pick<AuthConfig, 'key' | 'envTokens'>, username: string, epoch = 0): string | null =>
  cfg.envTokens[username.toLowerCase()] ?? (cfg.key ? deriveToken(cfg.key, username, epoch) : null);

const safeEq = (a: string, b: string) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };
const bearer = (req: express.Request) => /^Bearer ([A-Za-z0-9._~+/=-]{20,300})$/.exec(req.header('authorization') ?? '')?.[1] ?? null;

declare module 'express-serve-static-core' { interface Request { actor?: Actor } }

/** Resolves the bearer token to a user. No token / wrong token -> 401. Never logs the token. */
export function userAuth(db: Db, cfg: AuthConfig): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const t = bearer(req);
      if (!t) { res.status(401).json({ error: 'unauthenticated', hint: 'send Authorization: Bearer <your token>' }); return; }
      const users = (await db.query('SELECT id, username, role, token_epoch FROM users')).rows;
      let hit: { id: number; username: string; role: Role } | null = null;
      for (const u of users) { const want = tokenFor(cfg, u.username, u.token_epoch); if (want && safeEq(t, want)) hit = u; } // no early exit: constant work per user
      if (!hit) { res.status(401).json({ error: 'unauthenticated' }); return; }
      req.actor = { userId: hit.id, role: hit.role, label: hit.username };
      next();
    } catch (e) { next(e); }
  };
}

/** Admin gate: 404 unless ENABLE_ADMIN_ROUTES=true; then the admin bearer token is required. Sets a `system` actor labelled admin. */
export function adminAuth(cfg: AuthConfig): express.RequestHandler {
  return (req, res, next) => {
    if (!cfg.enableAdmin) { res.status(404).json({ error: 'not_found' }); return; }
    const t = bearer(req);
    if (!cfg.adminToken || !t || !safeEq(t, cfg.adminToken)) { res.status(401).json({ error: 'unauthenticated', hint: 'admin token required' }); return; }
    req.actor = { userId: null, role: 'system', label: 'admin' };
    next();
  };
}
