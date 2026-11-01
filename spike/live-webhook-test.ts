// Runs a REAL sandbox authorize -> capture -> void with a test card, then polls the deployed
// service's /api/debug/webhooks for the real events. SANDBOX ONLY.
// Usage: SERVICE_URL=https://<service>.onrender.com npm run live-test
const BASE = 'https://api-m.sandbox.paypal.com';
const SERVICE = process.env.SERVICE_URL;
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!SERVICE || !id || !secret) { console.error('Need SERVICE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET'); process.exit(2); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const tok = ((await (await fetch(BASE + '/v1/oauth2/token', { method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials' })).json()) as any).access_token;
const api = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(BASE + p, { method: m, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': crypto.randomUUID() }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : {} };
};
const card = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Test Buyer',
  billing_address: { address_line_1: '123 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } };
const mkOrder = async () => { const r = await api('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }], payment_source: { card } });
  return { order: r.json.id as string, auth: r.json.purchase_units?.[0]?.payments?.authorizations?.[0]?.id as string }; };

const a = await mkOrder();
const cap = await api('POST', `/v2/payments/authorizations/${a.auth}/capture`, { final_capture: true });
const b = await mkOrder();
const voided = await api('POST', `/v2/payments/authorizations/${b.auth}/void`);
console.log(JSON.stringify({ order_capture: a.order, auth_capture: a.auth, capture: cap.json.id, capture_status: cap.json.status, order_void: b.order, auth_void: b.auth, void_http: voided.status }));

const want = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.AUTHORIZATION.VOIDED'];
const end = Date.now() + 180_000; let events: any[] = [];
while (Date.now() < end) {
  events = ((await (await fetch(SERVICE + '/api/debug/webhooks')).json()) as any).events;
  if (want.every(t => events.some(e => e.type === t && e.verified))) break;
  await sleep(5000);
}
for (const t of want) { const e = events.find(x => x.type === t); console.log(`${e?.verified ? 'PASS' : 'FAIL'} ${t} ${e ? `${e.id} verified=${e.verified} at ${e.received_at}` : 'not received'}`); }
console.log('all events:', JSON.stringify(events));
