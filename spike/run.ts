// Guardian Pay day-1 PayPal SANDBOX spike. Sandbox only. Run: npm run spike
// Needs env PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET. Optional: ./cloudflared binary for a quick tunnel.
import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const BASE = 'https://api-m.sandbox.paypal.com'; // hard-coded sandbox; never live
const ID = process.env.PAYPAL_CLIENT_ID, SECRET = process.env.PAYPAL_CLIENT_SECRET;
if (!ID || !SECRET) { console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'); process.exit(2); }
const t0 = Date.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Row = { step: string; result: 'PASS' | 'FAIL' | 'INFO'; note: string };
const rows: Row[] = [];
const ids: Record<string, any> = {};
const add = (step: string, result: Row['result'], note: string) => { rows.push({ step, result, note }); console.log(`[${result}] ${step}: ${note}`); };

let token = '';
async function auth() {
  const r = await fetch(BASE + '/v1/oauth2/token', { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  if (!r.ok) throw new Error('oauth failed ' + r.status);
  token = (await r.json() as any).access_token;
}
async function api(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}
const issue = (j: any) => j?.details?.[0]?.issue ?? j?.name ?? '';

// Sandbox test card (Visa 4032 prefix; PayPal sandbox card generator style, passes Luhn)
const CARD = { number: '4032039317984658', expiry: '2030-12', security_code: '123', name: 'Test Buyer',
  billing_address: { address_line_1: '123 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } };

async function newAuthorizedOrder(amount = '10.00') {
  const r = await api('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: amount } }],
    payment_source: { card: CARD } }, { 'PayPal-Request-Id': randomUUID() });
  const a = r.json?.purchase_units?.[0]?.payments?.authorizations?.[0];
  return { r, orderId: r.json?.id as string, authId: a?.id as string, status: a?.status as string };
}

// ---------- webhook receiver ----------
const received: { type: string; id: string; headers: any; body: any }[] = [];
function startServer(): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      try { const body = JSON.parse(b); received.push({ type: body.event_type, id: body.id, headers: req.headers, body }); } catch {}
      res.writeHead(200).end('ok');
    });
  });
  return new Promise(r => s.listen(0, () => r(s)));
}
function startTunnel(port: number): Promise<{ proc: ChildProcess; url: string } | null> {
  if (!existsSync(new URL('./cloudflared', import.meta.url))) return Promise.resolve(null);
  const proc = spawn(new URL('./cloudflared', import.meta.url).pathname, ['tunnel', '--protocol', 'http2', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise(res => {
    const to = setTimeout(() => { proc.kill(); res(null); }, 25000);
    // 'Registered tunnel connection' means the edge link is up (URL alone is printed before that)
    let url = ''; const on = (d: Buffer) => { const t = d.toString(); const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(t); if (m) url = m[0];
      if (url && /Registered tunnel connection/.test(t)) { clearTimeout(to); res({ proc, url }); } };
    proc.stdout!.on('data', on); proc.stderr!.on('data', on);
  });
}
async function waitFor(type: string, ms = 90000, since = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const e = received.slice(since).find(x => x.type === type); if (e) return e; await sleep(1000); }
  return null;
}

async function main() {
  await auth();
  add('0 OAuth (sandbox)', 'PASS', 'token ok');

  // webhook setup
  let webhookId = '', server: http.Server | undefined, tunnel: { proc: ChildProcess; url: string } | null = null;
  const EVENTS = ['PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED'];
  try {
    server = await startServer();
    tunnel = await startTunnel((server.address() as any).port);
    // Webhook registration is exercised either way; real delivery is only asserted when the tunnel is live.
    {
      const w = await api('POST', '/v1/notifications/webhooks', { url: (tunnel?.url ?? 'https://example.com/guardian-pay-spike') + '/webhook', event_types: EVENTS.map(name => ({ name })) });
      if (w.status === 201) { webhookId = w.json.id; ids.webhookId = webhookId; add('6-pre Register sandbox webhook', 'PASS', `${webhookId} -> ${tunnel ? 'live tunnel' : 'placeholder URL (no working tunnel in this box)'}`); }
      else add('6-pre Register sandbox webhook', 'FAIL', `HTTP ${w.status} ${issue(w.json)}`);
    }

    // 1. create + authorize via server-side card
    const o1 = await newAuthorizedOrder();
    ids.order1 = o1.orderId; ids.auth1 = o1.authId;
    if (o1.r.status === 201 && o1.authId && o1.status === 'CREATED')
      add('1 Create AUTHORIZE order + authorize (card payment_source)', 'PASS', `order ${o1.orderId} (${o1.r.json.status}) auth ${o1.authId} ${o1.status}; no buyer-approval step needed`);
    else add('1 Create AUTHORIZE order + authorize (card payment_source)', 'FAIL', `HTTP ${o1.r.status} ${issue(o1.r.json)}`);
    // 1b. explicit /authorize on an already-authorized order
    if (o1.orderId) {
      const again = await api('POST', `/v2/checkout/orders/${o1.orderId}/authorize`, {}, { 'PayPal-Request-Id': randomUUID() });
      add('1b POST /orders/{id}/authorize after card create', 'INFO', `HTTP ${again.status} ${issue(again.json)} (card create auto-authorizes)`);
    }
    // 1c. buyer-approval path (no payment_source): shows approval URL needed
    const ap = await api('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }],
      payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } } }, { 'PayPal-Request-Id': randomUUID() });
    const link = ap.json?.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    ids.order_approval_flow = ap.json?.id;
    if (ap.json?.id) {
      const na = await api('POST', `/v2/checkout/orders/${ap.json.id}/authorize`, {}, { 'PayPal-Request-Id': randomUUID() });
      add('1c PayPal-wallet order: approval URL + authorize before approval', 'INFO', `create ${ap.status} ${ap.json.status}, approval link ${link ? 'present' : 'missing'}; authorize w/o buyer approval => HTTP ${na.status} ${issue(na.json)}`);
    }

    // 2. capture (+ 5. idempotency on same auth)
    const mark = received.length;
    const reqId = randomUUID();
    const capBody = { amount: { currency_code: 'USD', value: '10.00' }, final_capture: true };
    const c1 = await api('POST', `/v2/payments/authorizations/${o1.authId}/capture`, capBody, { 'PayPal-Request-Id': reqId });
    ids.capture1 = c1.json?.id;
    if ((c1.status === 201 || c1.status === 200) && c1.json.status === 'COMPLETED') add('2 Capture authorization', 'PASS', `capture ${c1.json.id} ${c1.json.status} HTTP ${c1.status}`);
    else add('2 Capture authorization', 'FAIL', `HTTP ${c1.status} ${c1.json?.status ?? ''} ${issue(c1.json)}`);

    const c2 = await api('POST', `/v2/payments/authorizations/${o1.authId}/capture`, capBody, { 'PayPal-Request-Id': reqId });
    const ord = await api('GET', `/v2/checkout/orders/${o1.orderId}`);
    const caps = ord.json?.purchase_units?.[0]?.payments?.captures ?? [];
    ids.capture1_replay = c2.json?.id;
    const same = c2.json?.id === c1.json?.id;
    if (caps.length === 1 && same) add('5 Idempotency (same PayPal-Request-Id twice)', 'PASS', `replay HTTP ${c2.status} returned same capture ${c2.json.id}; order has ${caps.length} capture`);
    else add('5 Idempotency (same PayPal-Request-Id twice)', 'FAIL', `replay HTTP ${c2.status} ${issue(c2.json)} sameId=${same} captures=${caps.length}`);

    // 3. authorize then void
    const o3 = await newAuthorizedOrder();
    ids.order3 = o3.orderId; ids.auth3 = o3.authId;
    const v = await api('POST', `/v2/payments/authorizations/${o3.authId}/void`, undefined, { 'PayPal-Request-Id': randomUUID() });
    const chk = await api('GET', `/v2/payments/authorizations/${o3.authId}`);
    if ((v.status === 204 || v.status === 200) && chk.json?.status === 'VOIDED') add('3 Authorize then void', 'PASS', `auth ${o3.authId} void HTTP ${v.status}, status now ${chk.json.status}`);
    else add('3 Authorize then void', 'FAIL', `void HTTP ${v.status} ${issue(v.json)}; status ${chk.json?.status}`);

    // 4. reauthorize inside honor period
    const o4 = await newAuthorizedOrder();
    ids.order4 = o4.orderId; ids.auth4 = o4.authId;
    const re = await api('POST', `/v2/payments/authorizations/${o4.authId}/reauthorize`, { amount: { currency_code: 'USD', value: '10.00' } }, { 'PayPal-Request-Id': randomUUID() });
    const reIssue = issue(re.json);
    if (re.status === 422 && reIssue === 'REAUTHORIZATION_TOO_SOON') add('4 Reauthorize in honor period (expect 422)', 'PASS', `HTTP 422 ${reIssue} (expected)`);
    else add('4 Reauthorize in honor period (expect 422)', 'FAIL', `HTTP ${re.status} ${reIssue} ${re.json?.details?.[0]?.description ?? ''} - sandbox may not enforce honor period`);
    if (o4.authId) await api('POST', `/v2/payments/authorizations/${o4.authId}/void`, undefined, { 'PayPal-Request-Id': randomUUID() }); // cleanup

    // 6. webhooks
    if (webhookId && tunnel) {
      const ev = await waitFor('PAYMENT.CAPTURE.COMPLETED', 120000, mark);
      if (ev) {
        ids.webhookEventCaptureCompleted = ev.id;
        const h = ev.headers;
        const vr = await api('POST', '/v1/notifications/verify-webhook-signature', {
          auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
          transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId, webhook_event: ev.body });
        add('6a Real webhook PAYMENT.CAPTURE.COMPLETED via tunnel', 'PASS', `event ${ev.id}, resource ${ev.body.resource?.id}; verify-webhook-signature=${vr.json?.verification_status ?? 'HTTP ' + vr.status}`);
      } else add('6a Real webhook PAYMENT.CAPTURE.COMPLETED via tunnel', 'FAIL', 'no event received in 120s');
      const vo = await waitFor('PAYMENT.AUTHORIZATION.VOIDED', 60000, mark);
      add('6b Real webhook PAYMENT.AUTHORIZATION.VOIDED', vo ? 'PASS' : 'FAIL', vo ? `event ${vo.id}` : 'not received in 60s');

      // simulator to registered webhook (mock events)
      for (const t of ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED']) {
        const m = received.length;
        const s = await api('POST', '/v1/notifications/simulate-event', { webhook_id: webhookId, event_type: t, resource_version: '2.0' });
        let got: any = null;
        if (s.status === 202 || s.status === 200) got = await waitFor(t, 45000, m);
        add(`6c Simulator ${t}`, s.status < 300 && got ? 'PASS' : 'FAIL', `simulate HTTP ${s.status} ${issue(s.json)} delivered=${!!got}`);
        if (t === 'PAYMENT.CAPTURE.COMPLETED' && got) {
          const h = got.headers;
          const vr = await api('POST', '/v1/notifications/verify-webhook-signature', { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'],
            transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId, webhook_event: got.body });
          add('6d verify-webhook-signature on SIMULATED event', 'INFO', `${vr.json?.verification_status ?? 'HTTP ' + vr.status} (expected FAILURE for mock events)`);
        }
      }
    } else {
      add('6a/6b Real webhook delivery', 'FAIL', 'no public tunnel could be established from this box (egress blocked); using simulator fallback');
      // Simulator accepts the event and echoes the mock payload. resource_version 2.0 is REQUIRED for DECLINED.
      for (const t of ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED']) {
        const s = await api('POST', '/v1/notifications/simulate-event', { url: 'https://example.com/webhook', event_type: t, resource_version: '2.0' });
        const ok = s.status === 202 && s.json?.event_type === t;
        add(`6c Simulator ${t}`, ok ? 'PASS' : 'FAIL', `HTTP ${s.status} ${issue(s.json)} resource_type=${s.json?.resource_type ?? ''}`);
      }
      const bad = await api('POST', '/v1/notifications/simulate-event', { url: 'https://example.com/webhook', event_type: 'PAYMENT.CAPTURE.DECLINED' });
      add('6c-note DECLINED without resource_version', 'INFO', `HTTP ${bad.status} ${bad.json?.details?.[0]?.issue ?? ''} (send resource_version 2.0)`);
      add('6d verify-webhook-signature on simulated events', 'INFO', 'not applicable: mock events carry no valid signature (per PayPal docs)');
    }
  } finally {
    if (webhookId) { const d = await api('DELETE', `/v1/notifications/webhooks/${webhookId}`); const l = await api('GET', '/v1/notifications/webhooks');
      const still = (l.json?.webhooks ?? []).some((w: any) => w.id === webhookId);
      add('6z Delete temp webhook', !still && d.status === 204 ? 'PASS' : 'FAIL', `DELETE HTTP ${d.status}, still listed=${still}`); }
    tunnel?.proc.kill(); server?.close();
  }
}

main().catch(e => add('FATAL', 'FAIL', String(e?.message ?? e))).finally(() => {
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('\n| Step | Result | Note |\n|---|---|---|');
  for (const r of rows) console.log(`| ${r.step} | ${r.result} | ${r.note} |`);
  console.log('\nIDs:', JSON.stringify(ids)); console.log(`Elapsed: ${secs}s`);
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ rows, ids, secs }, null, 2));
  process.exit(0);
});
