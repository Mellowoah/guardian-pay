# Guardian Pay

Hackathon demo of a PayPal **sandbox** payment flow: authorize, capture, void, reauthorize guard, idempotent capture, and a signature-verified webhook receiver.

> **Disclaimer:** This is a sandbox demo using synthetic data. It is not legal advice, and it is not a law firm. No live PayPal endpoints are used, and no real money moves.

## What is here
- `src/` — Express + TypeScript service (Node 20)
  - `GET /health`
  - `POST /webhooks/paypal` — verifies the signature via PayPal `POST /v1/notifications/verify-webhook-signature`, dedupes by event id, stores verified events
  - `GET /api/debug/webhooks` — read-only list of the last events (type, id, verified, received_at; no payloads)
- `spike/run.ts` — day-1 sandbox test: Orders v2 authorize, capture, void, reauthorize (`REAUTHORIZATION_TOO_SOON`), capture idempotency, webhook simulator
- `spike/live-webhook-test.ts` — runs a real sandbox authorize, capture and void, then checks the deployed service received the real events

## Run locally
```
cp .env.example .env   # fill in sandbox credentials; never commit .env
npm ci
npm run typecheck && npm test
npm run dev            # in-memory event store unless DATABASE_URL is set
npm run spike          # needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in the environment
```

## Storage
With `DATABASE_URL` set, events go to Postgres table `webhook_events` (unique `paypal_event_id`). Without it, an in-memory store is used.

## Safety
`PAYPAL_BASE` must be a sandbox host; the service refuses to start if it points at `api-m.paypal.com`.

License: MIT
