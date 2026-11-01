# Guardian Pay

Guardian Pay is the trust layer that lets AI-driven commerce scale safely on PayPal. **The AI suggests, a human decides, PayPal moves the money.** No code path captures funds without a recorded human approval.

Hackathon demo on the PayPal **sandbox**: milestone-based escrow-style payments built on Orders v2 `intent=AUTHORIZE`, with a guard module, append-only audit log, idempotent money calls, a 29-day authorization lifecycle and webhook reconciliation.

> **Disclaimer:** This is a sandbox demo using synthetic data. It is not legal advice, and it is not a law firm. No live PayPal endpoints are used, and no real money moves.

## What is here
- `src/` — Express + TypeScript service (Node 20)
  - `GET /health`
  - `POST /webhooks/paypal` — verifies the signature via PayPal `POST /v1/notifications/verify-webhook-signature`, dedupes by event id, stores verified events
  - `GET /api/debug/webhooks` — read-only list of the last events (type, id, verified, received_at; no payloads)
- `spike/run.ts` — day-1 sandbox test: Orders v2 authorize, capture, void, reauthorize (`REAUTHORIZATION_TOO_SOON`), capture idempotency, webhook simulator
- `spike/live-webhook-test.ts` — runs a real sandbox authorize, capture and void, then checks the deployed service received the real events

## Layer 1 backend (API)
Auth is a demo header `x-demo-user: family_demo | provider_demo | provider_two | reviewer_demo` (seeded synthetic users). Migrations run on startup.

| Endpoint | Who | What |
|---|---|---|
| `POST /api/cases` | provider | create a case with 1-10 milestones |
| `GET /api/cases/:id`, `GET /api/cases/:id/audit` | participants | case + payments; append-only audit trail |
| `POST /api/milestones/:id/order` | family/reviewer | `{payment_source:"card"}` authorizes with the sandbox card; `"paypal"` returns an `approve_url` |
| `POST /api/milestones/:id/authorize` | family/reviewer | wallet path, after the buyer approved at PayPal |
| `POST /api/milestones/:id/proof` / `verify` | provider / reviewer | `authorized -> proof_submitted -> verified` |
| `POST /api/milestones/:id/approve` | family/reviewer (never the provider) | records the approval, then captures; idempotent |
| `POST /api/milestones/:id/reject` | family/reviewer | `{reason}` required; voids the original authorization; idempotent |
| `GET/POST /api/admin/clock`, `POST /api/admin/run-jobs` | reviewer | demo fake clock (`FAKE_CLOCK_OFFSET_DAYS` env too) and run the lifecycle job now |

State machine: `created -> authorized -> (reauthorized) -> proof_submitted -> verified -> captured`; `proof_submitted -> rejected -> voided`; `authorized/reauthorized (and later holding states) -> expired` at day 29. Illegal transitions are rejected and every transition writes exactly one `audit_log` row.

Design notes
- **Guard:** every PayPal money call (order, authorize, capture, void, reauthorize) goes through `GuardedPayPal` / `checkMandate` in `src/guard.ts`; a test fails if any other file calls those client methods. Capture requires state `verified` and a stored approval row by a non-provider human.
- **Idempotency:** `PayPal-Request-Id = gp-<milestoneId>-<action>-<attempt>`; the attempt only bumps after a definitive PayPal 4xx. Each milestone is serialised with a Postgres advisory lock and PayPal is called outside DB transactions.
- **Lifecycle job (every 15 min, in-process):** reauthorize once after day 3 (new `current_authorization_id` stored next to `original_authorization_id`), warn at day 25, expire at day 29. Void always targets the original authorization.
- **Reconciliation:** verified `PAYMENT.CAPTURE.COMPLETED/DECLINED/DENIED` and `PAYMENT.AUTHORIZATION.VOIDED` events update the matching payment; any disagreement is flagged (`mismatch_flag`, `reconcile.override` audit row) and PayPal wins.
- Note: the fake clock is process-wide and only moves Guardian Pay's own time; PayPal still uses real time (so a reauthorize inside the real 3-day honor window is deferred).

## Tests
- `npm test` — unit tests; DB-backed tests (fake PayPal) run when `DATABASE_URL_TEST` is set (CI provides Postgres).
- `npm run integration` — live sandbox script against `BASE_URL` (default https://guardian-pay.onrender.com): happy path, double-click approve (one capture), reject/void, role negatives, fake-clock lifecycle, webhook confirmation.

## Run locally
```
cp .env.example .env   # fill in sandbox credentials; never commit .env
npm ci
npm run typecheck && npm test
npm run dev            # in-memory event store unless DATABASE_URL is set
npm run spike          # needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in the environment
```

## Storage
With `DATABASE_URL` set, everything is stored in Postgres (migrations on startup). Without it, only the webhook receiver runs, with an in-memory event store.

## Safety
`PAYPAL_BASE` must be a sandbox host; the service refuses to start if it points at `api-m.paypal.com`.

License: MIT
