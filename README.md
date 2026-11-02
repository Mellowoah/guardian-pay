# Guardian Pay

Guardian Pay is the trust layer that lets AI-driven commerce scale safely on PayPal. **The AI suggests, a human decides, PayPal moves the money.** No code path captures funds without a recorded human approval.

**Guarded Agent Payments on PayPal** (featured demo: MilestonePay, immigration help). Hackathon demo on the PayPal **sandbox**: milestone-based payments (funds are authorized up front and captured only after a human approves, to a payee that passed PayPal's checks and the public practitioner lists) built on Orders v2 `intent=AUTHORIZE`, with a guard module, append-only audit log, idempotent money calls, a 29-day authorization lifecycle and webhook reconciliation.

> **Disclaimer:** This is a sandbox demo using synthetic data. It is not legal advice, and it is not a law firm. No live PayPal endpoints are used, and no real money moves.

## What is here
- `src/` — Express + TypeScript service (Node 20)
  - `GET /health`
  - `POST /webhooks/paypal` — verifies the signature via PayPal `POST /v1/notifications/verify-webhook-signature`, dedupes by event id, stores verified events
  - `GET /api/debug/webhooks` — OFF by default; mounted only when `ENABLE_ADMIN_ROUTES=true` and then needs the admin token (type, id, verified, received_at; no payloads)
- `spike/run.ts` — day-1 sandbox test: Orders v2 authorize, capture, void, reauthorize (`REAUTHORIZATION_TOO_SOON`), capture idempotency, webhook simulator
- `spike/live-webhook-test.ts` — runs a real sandbox authorize, capture and void, then checks the deployed service received the real events

## Layer 1 backend (API)
Auth is a per-user **Bearer token** (`Authorization: Bearer gp_...`) for the seeded synthetic users `family_demo | provider_demo | provider_two | reviewer_demo`. Tokens are 256-bit HMAC values derived from a server secret (`GP_TOKEN_SECRET`; if unset, derived from the PayPal sandbox secret), or set explicitly with `GP_TOKEN_<USERNAME>` (>= 32 chars). `npm run seed-tokens` writes random per-user tokens to a git-ignored `.demo-tokens.env` (never printed). The old `x-demo-user` header authenticates nobody. Admin tokens can revoke a user's derived token (epoch bump). Migrations run on startup.

**Separation of duties:** the provider uploads proof, a **reviewer verifies** it, and only the **case family approves** (the reviewer never approves or funds). The family approval must name the proof it saw (`{proof_sha256, proof_id?}` from `GET /api/milestones/:id/proof`); if the proof changes, the approval is stale (409) and the guard refuses to capture. Verifier and approver must be different people. The family may also reject after verification.

| Endpoint | Who | What |
|---|---|---|
| `POST /api/cases` | provider | create a case with 1-10 milestones |
| `GET /api/cases/:id`, `GET /api/cases/:id/audit` | participants | case + payments; append-only audit trail |
| `POST /api/milestones/:id/order` | case family | `{payment_source:"card"}` authorizes with the sandbox card; `"paypal"` returns an `approve_url` |
| `POST /api/milestones/:id/authorize` | case family | wallet path, after the buyer approved at PayPal |
| `POST /api/milestones/:id/proof` / `verify` | provider / reviewer | `authorized -> proof_submitted -> verified` |
| `GET /api/milestones/:id/proof`, `/proof/image` | family, reviewer | current proof id + sha256 (what to approve); the stored image (nosniff, CSP none, no-store; 410 once purged) |
| `POST /api/milestones/:id/approve` | case family only | `{proof_sha256}` required; records the approval bound to that proof, then captures; idempotent |
| `POST /api/milestones/:id/reject` | family (also after verification) / reviewer (before) | `{reason}` required; voids the original authorization; idempotent |
| `GET/POST /api/admin/cases/:id/clock`, `POST /api/admin/run-jobs`, `POST /api/admin/users/:u/revoke-token` | admin token | NOT mounted unless `ENABLE_ADMIN_ROUTES=true`. Per-case demo clock (0-60 days, audited, `reason`), run the lifecycle job, revoke a token |

State machine: `created -> authorized -> (reauthorized) -> proof_submitted -> verified -> captured`; `proof_submitted -> rejected -> voided`; `authorized/reauthorized (and later holding states) -> expired` at day 29. Illegal transitions are rejected and every transition writes exactly one `audit_log` row.

Design notes
- **Guard:** every PayPal money call (order, authorize, capture, void, reauthorize) goes through `GuardedPayPal` / `checkMandate` in `src/guard.ts`; a test fails if any other file calls those client methods. Capture requires state `verified` and a stored approval row by a non-provider human.
- **Idempotency:** `PayPal-Request-Id = gp-<milestoneId>-<action>-<attempt>`; the attempt only bumps after a definitive PayPal 4xx. Each milestone is serialised with a Postgres advisory lock and PayPal is called outside DB transactions.
- **Lifecycle job (every 15 min, in-process):** reauthorize once after day 3 (new `current_authorization_id` stored next to `original_authorization_id`), warn at day 25, expire at day 29. Void always targets the original authorization.
- **Reconciliation:** verified `PAYMENT.CAPTURE.COMPLETED/DECLINED/DENIED` and `PAYMENT.AUTHORIZATION.VOIDED` events update the matching payment; any disagreement is flagged (`mismatch_flag`, `reconcile.override` audit row) and PayPal wins.
- Note: the demo clock is per case, admin-only and audited (`admin.clock_set`); it only moves Guardian Pay's own time. A milestone is expired **only when PayPal itself reports the authorization EXPIRED/VOIDED**; if the demo clock says day 30 but PayPal says otherwise, the tick writes `payment.expire_blocked` and changes nothing. A reauthorize inside PayPal's real 3-day honor window is deferred.
- **Proof reuse:** every uploaded image's sha256 and extracted receipt number go into a registry; the same image or receipt on another case fails the `proof_not_reused` check (no other-case ids are revealed) and goes to human review.
- **Production safety:** `AI_PROVIDER=fixture` refuses to start when `NODE_ENV=production` or on Render. `ALLOW_SANDBOX_CARD=false` disables the sandbox card path.

## Web UI (same service)
Open the service root (`/`). A thin, mobile-friendly, bilingual (EN/ES) UI in `public/` (plain JS, no build step; CSP-restricted; all data is rendered as text). It has **no money logic of its own**: every action calls the guard-backed API with the user's bearer token.
- **Payer / family:** the case, the payee verification badges (both checks, SIMULATED labels, EOIR snapshot dates, accreditation expirations), **Fund with PayPal** (the real PayPal JS SDK popup, `intent=authorize`: `createOrder` calls `POST /api/milestones/:id/order`, which makes the guard create the order; `onApprove` calls `POST .../authorize`; funds are only held), the proof image + AI check, and **Approve**, which sends the proof sha256 it showed.
- **Provider:** create a synthetic demo case, upload proof (or the synthetic sample receipt), onboarding link, milestone states.
- **Reviewer:** the proof, the AI check with every pass / fail / not run reason, and **Mark verified** (never an approval; nothing is automatic).
- **Sign-in** uses the existing bearer tokens. For the three demo actors, `PAYPAL_CLIENT_SECRET=... npm run demo-links -- https://guardian-pay.onrender.com ./demo_login_links.txt` writes one-click links (`/#login=<token>`) to a 0600 file without printing them; the token travels in the URL fragment (never sent to the server), is kept for the browser tab only, and is removed from the address bar. Or paste a token on the sign-in screen.
- `GET /api/config` (public) returns the sandbox PayPal client id (public by design) and SDK settings.
- A persistent footer says the app mirrors PayPal's checks, is not a legal determination, and uses synthetic data. UI copy avoids money-holding or identity-assurance claims.

## Payee verification (Layer 2)
Before any money moves, Guardian Pay checks **who is being paid**, with two separate checks that the guard requires together. It **mirrors PayPal's seller checks and public EOIR practitioner lists**; it does not confirm anyone's identity and is **not a legal determination**.

1. **PayPal ready to receive** (`paypal_ready`): the provider onboards through PayPal seller onboarding (`POST /v2/customer/partner-referrals` with `tracking_id` = provider id). "Verified by PayPal" requires `payments_receivable = true` AND `primary_email_confirmed = true` AND the authorize/capture and refund permissions in `oauth_third_party`. Each result is stored as an append-only snapshot with the time checked (`provider_verifications`). `MERCHANT.ONBOARDING.COMPLETED` binds and re-verifies; `MERCHANT.PARTNER-CONSENT.REVOKED` freezes funds.
2. **Authorized to practice** (`authorized_to_practice`): either an accredited representative of a **DOJ EOIR recognized organization**, or a licensed attorney, and **not on the EOIR currently-disciplined list**.
   - EOIR data is a **dated local snapshot** of the public pages (justice.gov, public domain): roster PDFs report date **2026-10-25**; currently disciplined page dated **2026-10-26**; previously disciplined page dated 2026-04-23 (`data/eoir/snapshot.json`, rebuilt by `scripts/build_eoir_snapshot.py`). Re-download before relying on it. Accreditation and recognition expirations are shown; an asterisk means **pending renewal** (valid, flagged). `(DHS only)` accreditation is noted.
   - A **confirmed** match on the currently-disciplined list (same name AND same state, not reinstated) is a **hard fail**. A possible match (similar name, different or unknown state, similar roster name) is `needs_review`, which blocks funds until a human looks. Reinstated or previously-disciplined entries are informational.
   - **Attorneys: SIMULATED.** The bar lookup is a labeled fixture (`data/bar/simulated_bar.json`, synthetic `SIM-` numbers). No bar data is scraped or republished; the result links to the official lookup for a manual check: https://www.floridabar.org/directories/find-mbr/.
   - The demo provider is a **SYNTHETIC** organization and person in `data/eoir/demo_overlay.json` (flagged `synthetic`); it is not on any EOIR list.

**Which PayPal path is live?** Referral creation is a **real** sandbox call (a hosted onboarding link). A real seller status read needs a seller to finish PayPal's hosted onboarding AND `PAYPAL_PARTNER_MERCHANT_ID` to be set; otherwise the status is a PayPal-shaped **SIMULATED** onboarding status, labeled `simulated: true` and "SIMULATED" in every reason and log line (merchant ids `SIMOK...` = ready, `SIMBAD...` = not ready). In simulated mode no payee is sent to PayPal; in live mode the **guard** sets `purchase_units[0].payee.merchant_id` so funds go to the provider, not the platform.

| Endpoint | Who | What |
|---|---|---|
| `GET /api/verify-payee/:providerId` | **public**, rate limited | `{verified, checks:[paypal_ready, authorized_to_practice], checked_at, source:"PayPal seller onboarding status", snapshot dates, simulated, ...}`, each check with status, English + Spanish reason, details |
| `POST /api/verify-payee` | provider (own) / reviewer | `{provider_id, merchant_id}` check a merchant id now |
| `POST /api/provider/onboarding` | provider | start PayPal seller onboarding; returns the `action_url` |
| `GET /api/cases/:id/payee` | participants | masked payee binding and any pending change |
| `POST /api/cases/:id/payee-change`, `/approve`, `/cancel`, `/apply` | provider requests; **family approves**; either cancels; either applies | change the payee |

**Immutable payee binding:** the provider's merchant id is bound to the case at creation and locked by a database trigger. Changing it requires (1) the new merchant to pass **both** checks, (2) **family approval**, (3) a **cooling delay** (`PAYEE_CHANGE_COOLING_HOURS`, default 72, measured on the case's demo clock) and (4) a fresh re-verification at apply time; every step is audited. Funding and capture are frozen while a change is open. The guard denies order, authorize and capture unless the bound payee passed both checks within `PAYEE_VERIFY_MAX_AGE_HOURS` (default 24) and matches the payee stamped on the payment. A void is never blocked.

Env (all optional): `PAYEE_ONBOARDING_MODE` (`auto` | `simulated`), `PAYPAL_PARTNER_MERCHANT_ID` (our partner merchant id, needed for live status reads), `PAYEE_CHANGE_COOLING_HOURS`, `PAYEE_VERIFY_MAX_AGE_HOURS`, `PAYEE_REFRESH_SECONDS` (reuse a snapshot younger than this; default 300).

## AI proof check (advisory)
`POST /api/milestones/:id/proof` now takes `{note?, filename?, file_base64?}` (PNG/JPEG/WebP, max 5 MB). It stores the bytes and a sha256, moves the milestone to `proof_submitted`, and starts a background check. `GET /api/milestones/:id/verification` returns the seven checks (pass / fail / not_run, each with an English and a Spanish reason), the score (0..1), the recommendation and an explanation.

- **The model only extracts fields** (form type, receipt number, dates, names, document type, legibility) as JSON, which is strictly validated. Fixed code in `src/verify/checks.ts` runs the checks and computes the score, so every result is repeatable and explainable.
- **Checks:** receipt format (3 letters + 10 digits), form type matches the milestone, notice date after case creation and not in the future, beneficiary name matches the case, document type matches the milestone, image legible / extraction confident, proof not used before (same image or receipt on another case). Weights 20/20/15/20/15/5/5; pass = full, not_run = half, fail = 0.
- **Recommendation:** score >= 0.8 `recommend_approve`; 0.5-0.8 `needs_human_review`; < 0.5 `recommend_reject`. It never recommends approval while any check failed or was not run, and never recommends rejection on incomplete evidence. **It never changes milestone state**: a reviewer still verifies and the family still approves before capture.
- **Untrusted extractions:** if the model reports the image as blurry/unreadable or its confidence is below 0.6, the five content checks are `not_run` (vision models can invent plausible text for smudged images) and a human looks.
- **Failure handling:** if the AI is down or returns garbage, the extraction is retried once; then all checks are `not_run` and the proof goes to human review.
- **Privacy:** proof bytes are deleted when the milestone is decided (captured, rejected, voided or expired); the sha256 and the audit trail stay.
- **Extractor (pluggable):** `AI_PROVIDER=gemini|openai` with `AI_API_KEY` (and optional `AI_MODEL`, default `gemini-3.1-flash-lite` for Gemini; the older `gemini-2.5-flash` now returns 404, `AI_BASE_URL` for any OpenAI-compatible endpoint). `AI_PROVIDER=fixture` is an offline extractor that reads the ground truth embedded in the synthetic fixture PNGs (demo and tests only, not OCR). Unset = no extractor: every proof goes to human review.
- **Eval:** `npm run eval` runs the 6 synthetic fixtures in `test/fixtures/proofs/` (regenerate with `python3 scripts/gen_fixtures.py`) and asserts the expected recommendations. Set `AI_PROVIDER`/`AI_API_KEY` to run it with real vision extraction.

## Tests
- `npm test` — unit tests; DB-backed tests (fake PayPal) run when `DATABASE_URL_TEST` is set (CI provides Postgres).
- `npm run integration` — live sandbox script against `BASE_URL` (default https://guardian-pay.onrender.com): happy path with separation of duties, double-click approve (one capture), reject/void, role and token negatives, proof reuse, webhook confirmation; lifecycle/clock checks run only when admin routes are enabled (set `ADMIN_TOKEN`).

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
