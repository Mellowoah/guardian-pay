export interface PayPalConfig { base: string; clientId: string; clientSecret: string; webhookId: string }

/** Guard: this project is sandbox-only. */
export function assertSandbox(base: string) {
  const host = new URL(base).hostname;
  if (host === 'api-m.paypal.com' || host === 'api.paypal.com') throw new Error('Refusing to use live PayPal host; sandbox only');
}

let cached: { token: string; exp: number } | null = null;
async function accessToken(c: PayPalConfig, fetchImpl: typeof fetch) {
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
