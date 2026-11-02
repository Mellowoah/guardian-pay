import type { Db } from './db.js';
import { GuardedPayPal, GuardDenied, checkMandate, type Actor, type GuardCtx } from './guard.js';
import { isDefinitiveFailure, paypalIssue, type PayPalResult } from './paypal.js';
import { createHash } from 'node:crypto';
import { audit } from './audit.js';
import type { Verifier } from './verify/verifier.js';
import { sniffImage } from './verify/extraction.js';
import { addDays } from './clock.js';
import { HOLDING } from './state.js';
import { HttpError, loadMilestone, loadPayment, transition, updatePayment, actorLabel, attemptOf, bumped, mNow, caseNow, type MilestoneRow, type PaymentRow } from './repo.js';

/** Only the case's own family funds, approves and (through the guard) captures. A reviewer verifies; it never approves or spends. */
const assertCaseFamily = (actor: Actor, m: MilestoneRow, what: string) => {
  if (actor.role !== 'family' || actor.userId === null || actor.userId !== m.family_user_id) throw new HttpError(403, 'forbidden', `only the case's family can ${what}`);
};
const SHA_RE = /^[0-9a-f]{64}$/;
// Sandbox-only demo card (PayPal sandbox test Visa). Clients never send card data; they only ask for the demo card.
const SANDBOX_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Demo Buyer (sandbox)',
  billing_address: { address_line_1: '123 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } };

export interface ServiceOpts { publicBaseUrl: string; allowSandboxCard: boolean; verifier?: Verifier }
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const DOC_TYPES = ['receipt_notice', 'rfe_response', 'interview_notice'];

const AMOUNT_RE = /^\d{1,5}(\.\d{1,2})?$/;
const str = (v: unknown, max: number, field: string, required = true): string => {
  if (typeof v !== 'string' || (required && !v.trim())) { if (!required && v == null) return ''; throw new HttpError(400, 'bad_request', `${field} is required`); }
  if (v.length > max) throw new HttpError(400, 'bad_request', `${field} too long`);
  return v.trim();
};

export class Service {
  constructor(private db: Db, private guarded: GuardedPayPal, private opts: ServiceOpts) {}

  // ------------------------------------------------------------------ cases
  async createCase(actor: Actor, body: any) {
    if (actor.role !== 'provider') throw new HttpError(403, 'forbidden', 'only a provider can create a case');
    const title = str(body?.title, 200, 'title'); const description = str(body?.description, 2000, 'description', false);
    const ms = body?.milestones;
    if (!Array.isArray(ms) || ms.length < 1 || ms.length > 10) throw new HttpError(400, 'bad_request', 'milestones: 1-10 required');
    const items = ms.map((m: any, i: number) => {
      const amt = String(m?.amount ?? '');
      if (!AMOUNT_RE.test(amt) || Number(amt) <= 0 || Number(amt) > 10000) throw new HttpError(400, 'bad_request', `milestones[${i}].amount must be 0.01-10000.00`);
      const form = m?.form_type == null ? null : String(m.form_type).trim();
      if (form !== null && !/^[A-Za-z0-9 -]{1,20}$/.test(form)) throw new HttpError(400, 'bad_request', `milestones[${i}].form_type invalid`);
      const doc = m?.document_type == null ? null : String(m.document_type);
      if (doc !== null && !DOC_TYPES.includes(doc)) throw new HttpError(400, 'bad_request', `milestones[${i}].document_type must be one of ${DOC_TYPES.join(', ')}`);
      return { title: str(m?.title, 200, `milestones[${i}].title`), amount: Number(amt).toFixed(2), form, doc };
    });
    const beneficiary = str(body?.beneficiary_name, 120, 'beneficiary_name', false) || null; const caseType = str(body?.case_type, 60, 'case_type', false) || null;
    const familyName = typeof body?.family_username === 'string' ? body.family_username : 'family_demo';
    return this.db.tx(async c => {
      const prov = (await c.query('SELECT id FROM providers WHERE user_id = $1', [actor.userId])).rows[0];
      if (!prov) throw new HttpError(403, 'forbidden', 'no provider profile');
      const fam = (await c.query(`SELECT id FROM users WHERE username = $1 AND role = 'family'`, [familyName])).rows[0];
      if (!fam) throw new HttpError(400, 'bad_request', 'unknown family_username');
      const cs = (await c.query('INSERT INTO cases (title, description, provider_id, family_user_id, beneficiary_name, case_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [title, description || null, prov.id, fam.id, beneficiary, caseType])).rows[0];
      await audit(c, { actor: actorLabel(actor), action: 'case.create', targetType: 'case', targetId: cs.id, caseId: cs.id, before: null, after: { title, milestones: items.length } });
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const m = (await c.query('INSERT INTO milestones (case_id, seq, title, amount, expected_form_type, expected_document_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [cs.id, i + 1, items[i].title, items[i].amount, items[i].form, items[i].doc])).rows[0];
        await audit(c, { actor: actorLabel(actor), action: 'milestone.created', targetType: 'milestone', targetId: m.id, caseId: cs.id, before: null, after: { state: 'created', amount: m.amount } });
        out.push(publicMilestone(m));
      }
      return { id: cs.id, title: cs.title, currency: cs.currency, beneficiary_name: cs.beneficiary_name, case_type: cs.case_type, milestones: out };
    });
  }

  private async assertCaseAccess(actor: Actor, caseId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new HttpError(404, 'not_found', 'case not found');
    const r = (await this.db.query(`SELECT c.*, p.user_id AS provider_user_id FROM cases c JOIN providers p ON p.id = c.provider_id WHERE c.id = $1`, [caseId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'case not found');
    if (actor.role === 'provider' && actor.userId !== r.provider_user_id) throw new HttpError(403, 'forbidden', 'not your case');
    if (actor.role === 'family' && r.family_user_id !== actor.userId) throw new HttpError(403, 'forbidden', 'not your case');
    return r;
  }

  async getCase(actor: Actor, caseId: string) {
    const cs = await this.assertCaseAccess(actor, caseId);
    const ms = (await this.db.query(
      `SELECT m.*, (SELECT username FROM users WHERE id = m.verified_by) AS verified_by_name, (SELECT username FROM users WHERE id = m.approved_by) AS approved_by_name,
              row_to_json(p) AS payment FROM milestones m LEFT JOIN payments p ON p.milestone_id = m.id WHERE m.case_id = $1 ORDER BY m.seq`, [caseId])).rows;
    return { id: cs.id, title: cs.title, currency: cs.currency, beneficiary_name: cs.beneficiary_name, case_type: cs.case_type, milestones: ms.map(m => ({ ...publicMilestone(m), payment: m.payment ? publicPayment(m.payment) : null })) };
  }

  async getAudit(actor: Actor, caseId: string) {
    await this.assertCaseAccess(actor, caseId);
    const rows = (await this.db.query('SELECT id, at, actor, action, target_type, target_id, before, after FROM audit_log WHERE case_id = $1 ORDER BY id', [caseId])).rows;
    return { case_id: caseId, count: rows.length, entries: rows };
  }

  // ------------------------------------------------------------------ admin (demo clock is per case, admin only, audited)
  async getCaseClock(caseId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new HttpError(404, 'not_found', 'case not found');
    const r = (await this.db.query('SELECT clock_offset_days FROM cases WHERE id = $1', [caseId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'case not found');
    return { case_id: caseId, offset_days: r.clock_offset_days, now: caseNow(r.clock_offset_days).toISOString() };
  }
  async setCaseClock(admin: Actor, caseId: string, days: unknown, reason: unknown) {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 0 || d > 60) throw new HttpError(400, 'bad_request', 'offset_days must be an integer 0-60');
    if (admin.role !== 'system') throw new HttpError(403, 'forbidden', 'admin only');
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new HttpError(404, 'not_found', 'case not found');
    return this.db.tx(async c => {
      const r = (await c.query('SELECT clock_offset_days FROM cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
      if (!r) throw new HttpError(404, 'not_found', 'case not found');
      await c.query('UPDATE cases SET clock_offset_days = $2 WHERE id = $1', [caseId, d]);
      await audit(c, { actor: actorLabel(admin), action: 'admin.clock_set', targetType: 'case', targetId: caseId, caseId, before: { offset_days: r.clock_offset_days },
        after: { offset_days: d, now: caseNow(d).toISOString(), reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
          note: 'demo clock for THIS case only; PayPal still uses real time; an authorization is only ever marked expired if PayPal agrees' } });
      return { case_id: caseId, offset_days: d, now: caseNow(d).toISOString() };
    });
  }
  async revokeUserToken(admin: Actor, username: string) {
    if (admin.role !== 'system') throw new HttpError(403, 'forbidden', 'admin only');
    const r = (await this.db.query('UPDATE users SET token_epoch = token_epoch + 1 WHERE username = $1 RETURNING id, token_epoch', [username])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'unknown user');
    await audit(this.db.pool, { actor: actorLabel(admin), action: 'admin.token_revoked', targetType: 'user', targetId: String(r.id), before: null, after: { username, token_epoch: r.token_epoch } });
    return { username, token_epoch: r.token_epoch, note: 'the previous derived token no longer works; GP_TOKEN_<USER> env tokens are rotated by changing the env' };
  }

  // ------------------------------------------------------------------ funding
  private ctx(actor: Actor, m: MilestoneRow, p: PaymentRow | null, action: string, state = m.state): GuardCtx {
    return { actor, milestone: { id: m.id, state, providerUserId: m.provider_user_id }, amount: m.amount, attempt: attemptOf(p, action) };
  }
  private failure(res: PayPalResult, fallback: string): HttpError {
    const issue = paypalIssue(res.body);
    return new HttpError(res.status >= 500 ? 502 : 422, 'paypal_error', `${fallback}: ${issue}`, { paypal_status: res.status, paypal_issue: issue });
  }
  private async recordFailure(m: MilestoneRow, action: string, res: PayPalResult) {
    await this.db.tx(async c => {
      const p = await loadPayment(c, m.id); if (!p) return;
      const sets: Record<string, unknown> = { last_error: `${action}: ${res.status} ${paypalIssue(res.body)}` };
      if (isDefinitiveFailure(res.status)) sets.attempts = bumped(p, action);
      await updatePayment(c, p.id, sets);
    }, m.id);
  }

  async openOrder(actor: Actor, milestoneId: string, body: any): Promise<any> {
    const useCard = body?.payment_source === 'card';
    if (useCard && !this.opts.allowSandboxCard) throw new HttpError(400, 'bad_request', 'sandbox card disabled');
    if (body?.payment_source && !['card', 'paypal'].includes(body.payment_source)) throw new HttpError(400, 'bad_request', 'payment_source must be card or paypal');
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      assertCaseFamily(actor, m, 'fund a milestone');
      let p = await loadPayment(c, m.id);
      if (m.state !== 'created') throw new HttpError(409, 'conflict', `milestone is ${m.state}`);
      if (p?.status === 'order_created') { if (useCard) throw new HttpError(409, 'conflict', 'a PayPal-wallet order already exists for this milestone'); return { m, p, existing: true }; }
      if (p && p.status !== 'pending_order') throw new HttpError(409, 'conflict', `payment is ${p.status}`);
      if (!p) {
        p = (await c.query('INSERT INTO payments (milestone_id, amount, currency) VALUES ($1,$2,$3) RETURNING *', [m.id, m.amount, m.currency])).rows[0];
        await audit(c, { actor: actorLabel(actor), action: 'payment.create', targetType: 'payment', targetId: p!.id, caseId: m.case_id, before: null, after: { status: 'pending_order', amount: m.amount } });
      }
      return { m, p: p!, existing: false };
    }, milestoneId);
    if (pre.existing) return { milestone: publicMilestone(pre.m), payment: publicPayment(pre.p), approve_url: pre.p.approve_url };

    const { m, p } = pre;
    const payment_source = useCard ? { card: SANDBOX_CARD } : { paypal: { experience_context: {
      brand_name: 'Guardian Pay (sandbox demo)', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
      return_url: `${this.opts.publicBaseUrl}/paypal/return`, cancel_url: `${this.opts.publicBaseUrl}/paypal/cancel` } } };
    const res = await this.guarded.order(this.ctx(actor, m, p, 'order'), {
      intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'default', custom_id: m.id, description: `Guardian Pay milestone ${m.seq} (sandbox, synthetic)`,
        amount: { currency_code: m.currency, value: m.amount } }], payment_source });
    if (res.status >= 300) { await this.recordFailure(m, 'order', res); throw this.failure(res, 'order failed'); }

    if (useCard) {
      const auth = res.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth || auth.status !== 'CREATED') { await this.recordFailure(m, 'order', { status: 422, body: { name: `AUTH_${auth?.status ?? 'MISSING'}` } }); throw new HttpError(422, 'paypal_error', `card authorization status ${auth?.status ?? 'missing'}`); }
      return this.db.tx(c => this.applyAuthorized(c, actor, m.id, res.body.id, auth), m.id);
    }
    const link = (res.body?.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!link) throw new HttpError(502, 'paypal_error', 'no approval link returned');
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (p2.status === 'pending_order') await updatePayment(c, p2.id, { paypal_order_id: res.body.id, approve_url: link, status: 'order_created', last_error: null });
      const p3 = (await loadPayment(c, m.id))!;
      return { milestone: publicMilestone(m2), payment: publicPayment(p3), approve_url: p3.approve_url };
    }, m.id);
  }

  async authorizeWallet(actor: Actor, milestoneId: string): Promise<any> {
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      assertCaseFamily(actor, m, 'authorize a milestone');
      if (m.state !== 'created') { if (p && ['authorized', 'reauthorized'].includes(p.status)) return { m, p, done: true }; throw new HttpError(409, 'conflict', `milestone is ${m.state}`); }
      if (!p || p.status !== 'order_created' || !p.paypal_order_id) throw new HttpError(409, 'conflict', 'create an order with payment_source=paypal first');
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: publicPayment(pre.p), idempotent: true };
    const res = await this.guarded.authorize(this.ctx(actor, pre.m, pre.p, 'authorize'), pre.p.paypal_order_id!);
    if (res.status >= 300) {
      await this.recordFailure(pre.m, 'authorize', res);
      const issue = paypalIssue(res.body);
      throw new HttpError(issue === 'ORDER_NOT_APPROVED' ? 409 : 422, issue === 'ORDER_NOT_APPROVED' ? 'buyer_approval_required' : 'paypal_error',
        issue === 'ORDER_NOT_APPROVED' ? 'the buyer has not approved the order yet; open approve_url first' : `authorize failed: ${issue}`, { paypal_issue: issue, approve_url: pre.p.approve_url });
    }
    const auth = res.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth || auth.status !== 'CREATED') throw new HttpError(422, 'paypal_error', `authorization status ${auth?.status ?? 'missing'}`);
    return this.db.tx(c => this.applyAuthorized(c, actor, pre.m.id, pre.p.paypal_order_id!, auth), pre.m.id);
  }

  private async applyAuthorized(c: import('pg').PoolClient, actor: Actor, milestoneId: string, orderId: string, auth: any) {
    const m = await loadMilestone(c, milestoneId, true); const p = (await loadPayment(c, milestoneId))!;
    if (m.state === 'created') {
      const now = mNow(m);
      await updatePayment(c, p.id, { paypal_order_id: orderId, original_authorization_id: auth.id, current_authorization_id: auth.id, authorized_at: now,
        honor_until: addDays(now, 3), expires_at: addDays(now, 29), status: 'authorized', last_error: null });
      await transition(c, m, 'authorized', actorLabel(actor), { order_id: orderId, authorization_id: auth.id, amount: m.amount });
    }
    const p2 = (await loadPayment(c, milestoneId))!;
    return { milestone: publicMilestone(m), payment: publicPayment(p2) };
  }

  // ------------------------------------------------------------------ proof / verify
  /** Provider uploads proof (JSON: {note?, filename?, file_base64?}). Stores bytes + sha256, moves to proof_submitted, starts the advisory AI check. */
  async submitProof(actor: Actor, milestoneId: string, body: any): Promise<any> {
    const note = str(body?.note, 2000, 'note', false);
    let file: { bytes: Buffer; mime: string; sha: string; filename: string | null } | null = null;
    if (body?.file_base64 != null) {
      if (typeof body.file_base64 !== 'string') throw new HttpError(400, 'bad_request', 'file_base64 must be a string');
      const b64 = body.file_base64.replace(/^data:[^;]+;base64,/, '');
      if (b64.length > Math.ceil(MAX_PROOF_BYTES * 4 / 3) + 8) throw new HttpError(413, 'too_large', `proof image must be at most ${MAX_PROOF_BYTES} bytes`);
      const bytes = Buffer.from(b64, 'base64');
      if (!bytes.length || bytes.length > MAX_PROOF_BYTES) throw new HttpError(413, 'too_large', `proof image must be 1..${MAX_PROOF_BYTES} bytes`);
      const mime = sniffImage(bytes);
      if (!mime) throw new HttpError(415, 'unsupported_media_type', 'proof must be a PNG, JPEG or WebP image');
      file = { bytes, mime, sha: createHash('sha256').update(bytes).digest('hex'), filename: typeof body.filename === 'string' ? body.filename.replace(/[^\w. -]/g, '_').slice(0, 100) : null };
    }
    if (!note && !file) throw new HttpError(400, 'bad_request', 'provide a note and/or file_base64');
    const out = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      if (actor.role !== 'provider' || actor.userId !== m.provider_user_id) throw new HttpError(403, 'forbidden', 'only the case provider can submit proof');
      if (m.state === 'proof_submitted') return { milestone: publicMilestone(m), idempotent: true as const };
      const text = note || `image proof uploaded${file?.filename ? ` (${file.filename})` : ''}`;
      await transition(c, m, 'proof_submitted', actorLabel(actor), { note_length: text.length, proof_sha256: file?.sha ?? null }, { proof_note: text, proof_submitted_at: mNow(m) });
      m.proof_note = text;
      const sha = file?.sha ?? createHash('sha256').update(text).digest('hex');
      const proof = (await c.query(`INSERT INTO proofs (milestone_id, uploaded_by, filename, content_type, size_bytes, sha256, has_image, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [m.id, actor.userId, file?.filename ?? null, file?.mime ?? 'text/plain', file?.bytes.length ?? text.length, sha, !!file, file?.bytes ?? null])).rows[0];
      // cross-case reuse registry: every image proof is recorded by hash (receipt number is added once extracted)
      if (file) await c.query('INSERT INTO proof_registry (proof_id, milestone_id, case_id, sha256) VALUES ($1,$2,$3,$4)', [proof.id, m.id, m.case_id, sha]);
      const info = { id: proof.id, sha256: sha, has_image: !!file, size_bytes: file?.bytes.length ?? text.length };
      if (!this.opts.verifier) return { milestone: publicMilestone(m), proof: info };
      const run = (await c.query(`INSERT INTO verification_runs (proof_id, milestone_id, provider) VALUES ($1,$2,$3) RETURNING id`, [proof.id, m.id, this.opts.verifier.provider])).rows[0];
      return { milestone: publicMilestone(m), proof: info, verification: { run_id: run.id, status: 'running', advisory_only: true } };
    }, milestoneId);
    if ('verification' in out && out.verification && this.opts.verifier) this.opts.verifier.start(out.verification.run_id);
    return out;
  }

  async verification(actor: Actor, milestoneId: string) {
    const m = await loadMilestone(this.db.pool, milestoneId);
    await this.assertCaseAccess(actor, m.case_id);
    if (!this.opts.verifier) throw new HttpError(404, 'not_found', 'AI proof check is not enabled');
    const v = await this.opts.verifier.latest(m.id);
    if (!v) throw new HttpError(404, 'not_found', 'no proof has been submitted for this milestone');
    return { milestone_id: m.id, milestone_state: m.state, ...v };
  }

  /** The reviewer VERIFIES the proof. This is not an approval: only the case's family approves, and it cannot be the same person. */
  async verifyProof(actor: Actor, milestoneId: string, body: any) {
    const note = str(body?.note, 1000, 'note', false);
    return this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true);
      if (actor.role !== 'reviewer') throw new HttpError(403, 'forbidden', 'only a reviewer can verify proof');
      if (m.state === 'verified') return { milestone: publicMilestone(m), idempotent: true };
      const proof = await latestProof(c, m.id);
      if (!proof) throw new HttpError(409, 'conflict', 'no proof is on file for this milestone');
      await transition(c, m, 'verified', actorLabel(actor), { note, verified_by: actor.label, proof_id: proof.id, proof_sha256: proof.sha256 },
        { verified_note: note || null, verified_by: actor.userId, verified_at: new Date(), verified_proof_sha256: proof.sha256 });
      m.verified_by = actor.userId; m.verified_by_name = actor.label;
      return { milestone: publicMilestone(m) };
    }, milestoneId);
  }

  /** What the family/reviewer/provider are looking at: the proof on file, with the sha256 an approval must be bound to. */
  async currentProof(actor: Actor, milestoneId: string) {
    const m = await loadMilestone(this.db.pool, milestoneId);
    await this.assertCaseAccess(actor, m.case_id);
    const r = await latestProof(this.db.pool, m.id);
    if (!r) throw new HttpError(404, 'not_found', 'no proof has been submitted for this milestone');
    return { milestone_id: m.id, milestone_state: m.state, proof_id: r.id, sha256: r.sha256, size_bytes: r.size_bytes, filename: r.filename, content_type: r.content_type,
      has_image: r.has_image, image_available: r.has_image && !r.bytes_deleted_at, image_url: r.has_image ? `/api/milestones/${m.id}/proof/image` : null, submitted_at: r.created_at,
      verified_by: m.verified_by_name ?? null, verified_proof_sha256: m.verified_proof_sha256 ?? null,
      approve_with: { proof_id: r.id, proof_sha256: r.sha256, note: 'POST /approve must send the proof_sha256 you were shown; if the proof changed the approval is refused' } };
  }

  /** Proof image bytes: reviewer, or the family that owns the case. Never the public, never another family. */
  async proofImage(actor: Actor, milestoneId: string): Promise<{ bytes: Buffer; mime: string; sha256: string }> {
    const m = await loadMilestone(this.db.pool, milestoneId);
    if (actor.role === 'family') assertCaseFamily(actor, m, 'view this proof image');
    else if (actor.role !== 'reviewer') throw new HttpError(403, 'forbidden', 'only the case family or a reviewer can view the proof image');
    const r = await latestProof(this.db.pool, m.id);
    if (!r || !r.has_image) throw new HttpError(404, 'not_found', 'no proof image for this milestone');
    if (!r.bytes) throw new HttpError(410, 'gone', 'the proof image was deleted after the decision (the sha256 hash and audit trail remain)');
    return { bytes: r.bytes as Buffer, mime: r.content_type, sha256: r.sha256 };
  }

  // ------------------------------------------------------------------ approve -> capture
  /** The case's FAMILY approves the exact proof it was shown ({proof_sha256}); that approval, bound to the verified proof, is what lets the guard capture. */
  async approve(actor: Actor, milestoneId: string, body: any = {}): Promise<any> {
    const seen = typeof body?.proof_sha256 === 'string' ? body.proof_sha256.toLowerCase() : '';
    if (!SHA_RE.test(seen)) throw new HttpError(400, 'bad_request', 'proof_sha256 is required: approve the proof you were shown (GET /api/milestones/:id/proof)');
    const seenId = typeof body?.proof_id === 'string' ? body.proof_id : null;
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      assertCaseFamily(actor, m, 'approve a milestone');
      if (m.state === 'captured') return { m, p, done: true };
      if (m.state !== 'verified') throw new HttpError(409, 'conflict', `milestone must be verified to approve (is ${m.state})`);
      if (!p?.current_authorization_id) throw new HttpError(409, 'conflict', 'no authorization on this milestone');
      const proof = await latestProof(c, m.id);
      if (!proof || proof.sha256 !== seen || (seenId && seenId !== proof.id)) throw new HttpError(409, 'stale_proof', 'the proof on file is not the one you approved; look at the current proof and approve again', { current_proof_sha256: proof?.sha256 ?? null });
      if (m.verified_proof_sha256 !== proof.sha256) throw new HttpError(409, 'proof_not_verified', 'the proof on file was not the one the reviewer verified');
      const have = (await c.query(`SELECT 1 FROM approvals WHERE milestone_id=$1 AND user_id=$2 AND decision='approve' AND proof_sha256=$3`, [m.id, actor.userId, proof.sha256])).rowCount;
      if (!have) {
        await c.query(`INSERT INTO approvals (milestone_id, user_id, decision, proof_id, proof_sha256) VALUES ($1,$2,'approve',$3,$4)`, [m.id, actor.userId, proof.id, proof.sha256]);
        await c.query('UPDATE milestones SET approved_by = $2, approved_at = now() WHERE id = $1', [m.id, actor.userId]);
        await audit(c, { actor: actorLabel(actor), action: 'approval.approve', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: null,
          after: { decision: 'approve', approved_by: actor.label, verified_by: m.verified_by_name, proof_id: proof.id, proof_sha256: proof.sha256 } });
      }
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: pre.p ? publicPayment(pre.p) : null, idempotent: true };

    const { m, p } = pre;
    let res: PayPalResult;
    try { res = await this.guarded.capture(this.ctx(actor, m, p, 'capture', 'verified'), p!.current_authorization_id!, m.currency); }
    catch (e) { if (e instanceof GuardDenied) throw new HttpError(403, 'guard_denied', e.reason); throw e; }

    let captureId: string | undefined; let captureStatus: string | undefined;
    if (res.status < 300) { captureId = res.body?.id; captureStatus = res.body?.status; }
    else if (paypalIssue(res.body) === 'AUTHORIZATION_ALREADY_CAPTURED') {
      const ord = await this.guarded.getOrder(p!.paypal_order_id!);
      const cap = ord.body?.purchase_units?.[0]?.payments?.captures?.[0];
      captureId = cap?.id; captureStatus = cap?.status;
    }
    if (!captureId) { await this.recordFailure(m, 'capture', res); throw this.failure(res, 'capture failed'); }

    if (captureStatus !== 'COMPLETED') {
      await this.db.tx(async c => { const p2 = (await loadPayment(c, m.id))!;
        if (!p2.capture_id) await updatePayment(c, p2.id, { capture_id: captureId, status: 'capture_pending', last_error: `capture ${captureStatus}` }); }, m.id);
      throw new HttpError(202, 'capture_pending', `capture ${captureStatus}; the PAYMENT.CAPTURE.COMPLETED webhook will finish it`, { capture_id: captureId });
    }
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (m2.state === 'captured') return { milestone: publicMilestone(m2), payment: publicPayment(p2), idempotent: true };
      await updatePayment(c, p2.id, { capture_id: captureId, status: 'captured', last_error: null });
      await transition(c, m2, 'captured', actorLabel(actor), { capture_id: captureId, authorization_id: p2.current_authorization_id, amount: m2.amount });
      return { milestone: publicMilestone(m2), payment: publicPayment((await loadPayment(c, m.id))!) };
    }, m.id);
  }

  // ------------------------------------------------------------------ reject -> void
  /** Reject/dispute -> void. The family can do this in proof_submitted AND after the reviewer verified; a reviewer can only reject unverified proof. */
  async reject(actor: Actor, milestoneId: string, body: any): Promise<any> {
    const reason = str(body?.reason, 500, 'reason');
    const pre = await this.db.tx(async c => {
      const m = await loadMilestone(c, milestoneId, true); const p = await loadPayment(c, m.id);
      if (actor.role === 'family') assertCaseFamily(actor, m, 'reject a milestone');
      else if (actor.role !== 'reviewer') throw new HttpError(403, 'forbidden', `role ${actor.role} may not reject`);
      if (m.state === 'voided') return { m, p, done: true };
      if (m.state === 'proof_submitted' || (m.state === 'verified' && actor.role === 'family')) {
        const proof = await latestProof(c, m.id);
        await c.query(`INSERT INTO approvals (milestone_id, user_id, decision, reason, proof_id, proof_sha256) VALUES ($1,$2,'reject',$3,$4,$5)`, [m.id, actor.userId, reason, proof?.id ?? null, proof?.sha256 ?? null]);
        await audit(c, { actor: actorLabel(actor), action: 'approval.reject', targetType: 'milestone', targetId: m.id, caseId: m.case_id, before: null,
          after: { decision: 'reject', reason, after_verification: m.state === 'verified', proof_sha256: proof?.sha256 ?? null } });
        await transition(c, m, 'rejected', actorLabel(actor), { reason, from: m.state }, { rejection_reason: reason });
      } else if (m.state !== 'rejected') throw new HttpError(409, 'conflict', `milestone must be proof_submitted (or verified, by the family) to reject (is ${m.state})`);
      if (!p?.original_authorization_id) throw new HttpError(409, 'conflict', 'no authorization on this milestone');
      return { m, p, done: false };
    }, milestoneId);
    if (pre.done) return { milestone: publicMilestone(pre.m), payment: pre.p ? publicPayment(pre.p) : null, idempotent: true };

    const { m, p } = pre;
    let res: PayPalResult;
    try { res = await this.guarded.void(this.ctx(actor, m, p, 'void', 'rejected'), p!.original_authorization_id!); }
    catch (e) { if (e instanceof GuardDenied) throw new HttpError(403, 'guard_denied', e.reason); throw e; }
    let ok = res.status < 300;
    if (!ok && paypalIssue(res.body) === 'AUTHORIZATION_VOIDED') ok = (await this.guarded.getAuthorization(p!.original_authorization_id!)).body?.status === 'VOIDED';
    if (!ok) { await this.recordFailure(m, 'void', res); throw this.failure(res, 'void failed (milestone stays rejected; retry reject)'); }
    return this.db.tx(async c => {
      const m2 = await loadMilestone(c, m.id, true); const p2 = (await loadPayment(c, m.id))!;
      if (m2.state === 'voided') return { milestone: publicMilestone(m2), payment: publicPayment(p2), idempotent: true };
      await updatePayment(c, p2.id, { status: 'voided', last_error: null });
      await transition(c, m2, 'voided', actorLabel(actor), { authorization_id: p2.original_authorization_id });
      return { milestone: publicMilestone(m2), payment: publicPayment((await loadPayment(c, m.id))!) };
    }, m.id);
  }
}

type Q = Pick<import('pg').PoolClient, 'query'>;
async function latestProof(q: Q, milestoneId: string) {
  return (await q.query('SELECT id, sha256, size_bytes, filename, content_type, has_image, bytes, bytes_deleted_at, created_at FROM proofs WHERE milestone_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [milestoneId])).rows[0] as
    { id: string; sha256: string; size_bytes: number; filename: string | null; content_type: string; has_image: boolean; bytes: Buffer | null; bytes_deleted_at: Date | null; created_at: Date } | undefined;
}
export const HOLDING_STATES = HOLDING;
export const publicMilestone = (m: any) => ({ id: m.id, case_id: m.case_id, seq: m.seq, title: m.title, amount: m.amount, state: m.state,
  expected_form_type: m.expected_form_type ?? null, expected_document_type: m.expected_document_type ?? null,
  proof_note: m.proof_note ?? null, rejection_reason: m.rejection_reason ?? null,
  verified_by: m.verified_by_name ?? null, approved_by: m.approved_by_name ?? null, disputed: !!m.disputed_at, dispute_note: m.dispute_note ?? null });
export const publicPayment = (p: any) => ({ id: p.id, status: p.status, amount: p.amount, currency: p.currency, order_id: p.paypal_order_id,
  original_authorization_id: p.original_authorization_id, current_authorization_id: p.current_authorization_id, authorized_at: p.authorized_at,
  reauthorized_at: p.reauthorized_at, honor_until: p.honor_until, expires_at: p.expires_at, capture_id: p.capture_id, reauth_count: p.reauth_count,
  last_error: p.last_error, mismatch_flag: p.mismatch_flag, mismatch_note: p.mismatch_note, webhook_confirmed_at: p.webhook_confirmed_at });
export { checkMandate };
