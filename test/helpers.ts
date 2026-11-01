import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { connect, type Db } from '../src/db.js';
import { migrate } from '../src/migrations.js';
import { PayPalClient } from '../src/paypal.js';
import { GuardedPayPal, type Actor } from '../src/guard.js';
import { Service } from '../src/services.js';

export const TEST_URL = process.env.DATABASE_URL_TEST;

/** Stateful fake of the PayPal sandbox endpoints we use. Honors PayPal-Request-Id replays like the real API. */
export class FakePayPal {
  calls: { method: string; path: string; requestId?: string; body?: any }[] = [];
  private replay = new Map<string, { status: number; body: any }>();
  auths = new Map<string, { status: string; orderId: string; amount: string; captures: string[] }>();
  orders = new Map<string, { auth?: string; custom_id: string; amount: string; captures: string[] }>();
  allowReauth = false; delayMs = 15; declineCapture = false; n = 0;
  get captureCalls() { return this.calls.filter(c => c.path.endsWith('/capture')); }
  get realCaptures() { return [...this.auths.values()].reduce((s, a) => s + a.captures.length, 0); }
  private id(p: string) { return `${p}-${(++this.n).toString().padStart(4, '0')}`; }
  fetch: typeof fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url)); const method = init.method ?? 'GET'; const path = u.pathname;
    if (path === '/v1/oauth2/token') return res(200, { access_token: 'fake', expires_in: 3600 });
    const requestId = init.headers?.['PayPal-Request-Id']; const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, requestId, body });
    await new Promise(r => setTimeout(r, this.delayMs));
    if (requestId && this.replay.has(requestId)) { const x = this.replay.get(requestId)!; return res(x.status, x.body); }
    const out = this.handle(method, path, body);
    if (requestId && method === 'POST') this.replay.set(requestId, out);
    return res(out.status, out.body);
  }) as any;
  private err(status: number, issue: string) { return { status, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }] } }; }
  private handle(method: string, path: string, body: any): { status: number; body: any } {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v2/checkout/orders') {
      const id = this.id('ORD'); const pu = body.purchase_units[0]; const o = { custom_id: pu.custom_id, amount: pu.amount.value, captures: [] as string[], auth: undefined as string | undefined };
      this.orders.set(id, o);
      if (body.payment_source?.card) { const a = this.id('AUTH'); o.auth = a; this.auths.set(a, { status: 'CREATED', orderId: id, amount: o.amount, captures: [] });
        return { status: 201, body: { id, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: a, status: 'CREATED' }] } }] } }; }
      return { status: 200, body: { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://sandbox.paypal.test/approve?token=${id}` }] } };
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/(capture|void|reauthorize)$/))) {
      const a = this.auths.get(m[1]); if (!a) return this.err(404, 'INVALID_RESOURCE_ID');
      if (m[2] === 'capture') {
        if (a.status === 'VOIDED') return this.err(422, 'AUTHORIZATION_VOIDED');
        if (a.captures.length) return this.err(422, 'AUTHORIZATION_ALREADY_CAPTURED');
        if (this.declineCapture) return this.err(422, 'INSTRUMENT_DECLINED');
        const cid = this.id('CAP'); a.captures.push(cid); a.status = 'CAPTURED'; this.orders.get(a.orderId)!.captures.push(cid);
        return { status: 201, body: { id: cid, status: 'COMPLETED' } };
      }
      if (m[2] === 'void') { if (a.status === 'VOIDED') return this.err(422, 'AUTHORIZATION_VOIDED'); a.status = 'VOIDED'; return { status: 200, body: {} }; }
      if (!this.allowReauth) return this.err(422, 'REAUTHORIZATION_TOO_SOON');
      const na = this.id('AUTH'); this.auths.set(na, { status: 'CREATED', orderId: a.orderId, amount: a.amount, captures: [] });
      return { status: 201, body: { id: na, status: 'CREATED' } };
    }
    if (method === 'POST' && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/))) {
      const o = this.orders.get(m[1]); if (!o) return this.err(404, 'INVALID_RESOURCE_ID');
      if (!(o as any).approved) return this.err(422, 'ORDER_NOT_APPROVED');
      const a = this.id('AUTH'); o.auth = a; this.auths.set(a, { status: 'CREATED', orderId: m[1], amount: o.amount, captures: [] });
      return { status: 201, body: { id: m[1], purchase_units: [{ payments: { authorizations: [{ id: a, status: 'CREATED' }] } }] } };
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
      const o = this.orders.get(m[1]); if (!o) return this.err(404, 'INVALID_RESOURCE_ID');
      return { status: 200, body: { id: m[1], purchase_units: [{ payments: { captures: o.captures.map(id => ({ id, status: 'COMPLETED' })) } }] } };
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)$/))) { const a = this.auths.get(m[1]); return a ? { status: 200, body: { id: m[1], status: a.status } } : this.err(404, 'INVALID_RESOURCE_ID'); }
    return this.err(404, 'NO_ROUTE ' + path);
  }
}
const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

export interface Env { db: Db; fake: FakePayPal; svc: Service; guarded: GuardedPayPal; family: Actor; provider: Actor; provider2: Actor; reviewer: Actor; close(): Promise<void> }
export async function setup(): Promise<Env> {
  const schema = 't_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const admin = new pg.Client({ connectionString: TEST_URL }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const db = connect(`${TEST_URL}${TEST_URL!.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}`);
  await migrate(db);
  const fake = new FakePayPal();
  const guarded = new GuardedPayPal(new PayPalClient({ base: 'https://api-m.sandbox.paypal.com', clientId: 'x', clientSecret: 'y' }, fake.fetch), db);
  const svc = new Service(db, guarded, { publicBaseUrl: 'http://localhost', allowSandboxCard: true });
  const u = async (name: string): Promise<Actor> => { const r = (await db.query('SELECT id, role FROM users WHERE username = $1', [name])).rows[0]; return { userId: r.id, role: r.role, label: name }; };
  return { db, fake, svc, guarded, family: await u('family_demo'), provider: await u('provider_demo'), provider2: await u('provider_two'), reviewer: await u('reviewer_demo'),
    async close() { await db.close(); const a = new pg.Client({ connectionString: TEST_URL }); await a.connect(); await a.query(`DROP SCHEMA ${schema} CASCADE`); await a.end(); } };
}
export async function newCase(e: Env, amounts = ['25.00']) {
  return e.svc.createCase(e.provider, { title: 'Test case (synthetic)', milestones: amounts.map((a, i) => ({ title: `M${i + 1}`, amount: a })) });
}
export async function fundedMilestone(e: Env) {
  const c = await newCase(e); const id = c.milestones[0].id;
  await e.svc.openOrder(e.family, id, { payment_source: 'card' });
  return { caseId: c.id, id };
}
export async function toVerified(e: Env) {
  const f = await fundedMilestone(e);
  await e.svc.submitProof(e.provider, f.id, { note: 'done' }); await e.svc.verifyProof(e.reviewer, f.id, {});
  return f;
}
