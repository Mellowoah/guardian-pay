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

## AI proof check (advisory)
`POST /api/milestones/:id/proof` now takes `{note?, filename?, file_base64?}` (PNG/JPEG/WebP, max 5 MB). It stores the bytes and a sha256, moves the milestone to `proof_submitted`, and starts a background check. `GET /api/milestones/:id/verification` returns the six checks (pass / fail / not_run, each with an English and a Spanish reason), the score (0..1), the recommendation and an explanation.

- **The model only extracts fields** (form type, receipt number, dates, names, document type, legibility) as JSON, which is strictly validated. Fixed code in `src/verify/checks.ts` runs the checks and computes the score, so every result is repeatable and explainable.
- **Checks:** receipt format (3 letters + 10 digits), form type matches the milestone, notice date after case creation and not in the future, beneficiary name matches the case, document type matches the milestone, image legible / extraction confident. Weights 20/20/15/20/15/10; pass = full, not_run = half, fail = 0.
- **Recommendation:** score >= 0.8 `recommend_approve`; 0.5-0.8 `needs_human_review`; < 0.5 `recommend_reject`. It never recommends approval while any check failed or was not run, and never recommends rejection on incomplete evidence. **It never changes milestone state**: a reviewer still verifies and a human still approves before capture.
- **Untrusted extractions:** if the model reports the image as blurry/unreadable or its confidence is below 0.6, the five content checks are `not_run` (vision models can invent plausible text for smudged images) and a human looks.
- **Failure handling:** if the AI is down or returns garbage, the extraction is retried once; then all checks are `not_run` and the proof goes to human review.
- **Privacy:** proof bytes are deleted when the milestone is decided (captured, rejected, voided or expired); the sha256 and the audit trail stay.
- **Extractor (pluggable):** `AI_PROVIDER=gemini|openai` with `AI_API_KEY` (and optional `AI_MODEL`, default `gemini-3.1-flash-lite` for Gemini; the older `gemini-2.5-flash` now returns 404, `AI_BASE_URL` for any OpenAI-compatible endpoint). `AI_PROVIDER=fixture` is an offline extractor that reads the ground truth embedded in the synthetic fixture PNGs (demo and tests only, not OCR). Unset = no extractor: every proof goes to human review.
- **Eval:** `npm run eval` runs the 6 synthetic fixtures in `test/fixtures/proofs/` (regenerate with `python3 scripts/gen_fixtures.py`) and asserts the expected recommendations. Set `AI_PROVIDER`/`AI_API_KEY` to run it with real vision extraction.

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
