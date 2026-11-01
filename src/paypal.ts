export interface PayPalConfig { base: string; clientId: string; clientSecret: string; webhookId: string }
export type ApiConfig = Pick<PayPalConfig, 'base' | 'clientId' | 'clientSecret'>

/** Guard: this project is sandbox-only. */
export function assertSandbox(base: string) {
  const host = new URL(base).hostname;
  if (host === 'api-m.paypal.com' || host === 'api.paypal.com') throw new Error('Refusing to use live PayPal host; sandbox only');
}

let cached: { token: string; exp: number } | null = null;
export async function accessToken(c: ApiConfig, fetchImpl: typeof fetch = fetch) {
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const r = await fetchImpl(c.base + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  if (!r.ok) throw new Error('paypal oauth failed: ' + r.status);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

export type Headers = Record<string, string | string[] | undefined>;
const h = (x: Headers, k: string) => String(x[k] ?? '');

/**
 * Calls PayPal verify-webhook-signature. The raw request body is spliced in as-is so the bytes
 * PayPal signed are not altered by a JSON re-serialisation.
 */
export async function verifyWebhookSignature(c: PayPalConfig, headers: Headers, rawBody: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await accessToken(c, fetchImpl);
  const head = JSON.stringify({
    auth_algo: h(headers, 'paypal-auth-algo'), cert_url: h(headers, 'paypal-cert-url'),
    transmission_id: h(headers, 'paypal-transmission-id'), transmission_sig: h(headers, 'paypal-transmission-sig'),
    transmission_time: h(headers, 'paypal-transmission-time'), webhook_id: c.webhookId });
  const body = head.slice(0, -1) + ',"webhook_event":' + rawBody + '}';
  const r = await fetchImpl(c.base + '/v1/notifications/verify-webhook-signature', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body });
  if (!r.ok) return 'ERROR_' + r.status;
  return ((await r.json()) as { verification_status?: string }).verification_status ?? 'UNKNOWN';
}

// ---------------------------------------------------------------------------------------------
// Thin REST client. Every money call REQUIRES a PayPal-Request-Id (see idempotency.ts).
// Application code must not call the money methods directly: they are reached only through
// GuardedPayPal in guard.ts (a unit test greps the source tree to enforce this).
// ---------------------------------------------------------------------------------------------
export interface PayPalResult { status: number; body: any }
export interface Money { currency_code: string; value: string }

export class PayPalClient {
  constructor(private cfg: ApiConfig, private fetchImpl: typeof fetch = fetch) { assertSandbox(cfg.base); }

  private async call(method: string, path: string, body?: unknown, requestId?: string): Promise<PayPalResult> {
    const token = await accessToken(this.cfg, this.fetchImpl);
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const r = await this.fetchImpl(this.cfg.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
    return { status: r.status, body: json };
  }

  // --- money calls: requestId is a required argument ---
  createOrder(order: unknown, requestId: string) { return this.call('POST', '/v2/checkout/orders', order, need(requestId)); }
  authorizeOrder(orderId: string, requestId: string) { return this.call('POST', `/v2/checkout/orders/${enc(orderId)}/authorize`, {}, need(requestId)); }
  captureAuthorization(authId: string, body: { amount: Money; final_capture: boolean }, requestId: string) {
    return this.call('POST', `/v2/payments/authorizations/${enc(authId)}/capture`, body, need(requestId)); }
  voidAuthorization(authId: string, requestId: string) { return this.call('POST', `/v2/payments/authorizations/${enc(authId)}/void`, undefined, need(requestId)); }
  reauthorizeAuthorization(authId: string, body: { amount: Money }, requestId: string) {
    return this.call('POST', `/v2/payments/authorizations/${enc(authId)}/reauthorize`, body, need(requestId)); }

  // --- reads (no money moves) ---
  getAuthorization(authId: string) { return this.call('GET', `/v2/payments/authorizations/${enc(authId)}`); }
  getOrder(orderId: string) { return this.call('GET', `/v2/checkout/orders/${enc(orderId)}`); }
}
const enc = encodeURIComponent;
function need(id: string) { if (!id || typeof id !== 'string') throw new Error('PayPal-Request-Id is required on money calls'); return id; }

/** definitive business failure (safe to bump the attempt number): 4xx except timeouts/rate limits */
export const isDefinitiveFailure = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;
export const paypalIssue = (b: any): string => b?.details?.[0]?.issue ?? b?.name ?? 'UNKNOWN';
