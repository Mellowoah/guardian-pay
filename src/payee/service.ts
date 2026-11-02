import type pg from 'pg';
import type { Db } from '../db.js';
import type { Actor } from '../guard.js';
import { audit } from '../audit.js';
import { HttpError, caseNow, actorLabel } from '../repo.js';
import { evaluatePayPal, redactStatus, PAYPAL_SOURCE, type PayPalCheck } from './paypalStatus.js';
import type { OnboardingProvider } from './onboarding.js';
import { PractitionerRegistry, FLORIDA_BAR_LOOKUP, type PracticeCheck } from './registry.js';

export interface PayeeOpts { coolingHours: number; refreshSeconds: number; publicBaseUrl: string; logger?: (m: string) => void }
export const DEFAULT_PAYEE_OPTS: PayeeOpts = { coolingHours: 72, refreshSeconds: 300, publicBaseUrl: 'http://localhost:3000' };
export const PAYEE_EVENT_TYPES = ['MERCHANT.ONBOARDING.COMPLETED', 'MERCHANT.PARTNER-CONSENT.REVOKED'];

const MERCHANT_RE = /^[A-Za-z0-9]{8,24}$/;
export const modeOfMerchant = (id: string): 'live' | 'simulated' => (/^SIM/.test(id) ? 'simulated' : 'live');
export const maskMerchant = (id: string | null) => (id ? (id.length <= 6 ? '***' : `${id.slice(0, 3)}…${id.slice(-3)}`) : null);

export interface PracticeOut extends Omit<PracticeCheck, 'route'> { id: 'authorized_to_practice'; label_en: string; label_es: string; route: string; source: string }
export interface VerifyOut {
  provider_id: number; display_name: string; verified: boolean;
  checks: [PayPalCheck, PracticeOut];
  checked_at: string; source: string; sources: string[];
  paypal_mode: 'live' | 'simulated' | 'none'; simulated: boolean; merchant_id_masked: string | null;
  snapshot: PracticeCheck['details']['snapshot']; bar_lookup_url: string;
  verification_id: number; reused: boolean;
  summary_en: string; summary_es: string; disclaimer_en: string; disclaimer_es: string;
}
const DISCLAIMER_EN = 'Guardian Pay mirrors PayPal’s seller checks and public EOIR practitioner lists (dated snapshot). It does not confirm anyone’s identity and is not a legal determination. Sandbox demo with synthetic data; SIMULATED parts are labeled.';
const DISCLAIMER_ES = 'Guardian Pay refleja las verificaciones de vendedor de PayPal y las listas públicas de EOIR (instantánea con fecha). No confirma la identidad de nadie y no es una determinación legal. Demostración en sandbox con datos sintéticos; las partes SIMULADAS están indicadas.';

interface ProviderRow { id: number; user_id: number; business_name: string; practitioner_type: 'recognized_org_rep' | 'attorney' | 'none'; person_name: string | null; org_name: string | null; practice_state: string | null; bar_number: string | null; tracking_id: string | null; merchant_id: string | null; consent_revoked_at: Date | null; action_url: string | null; referral_mode: string | null }

export class PayeeService {
  constructor(private db: Db, private onboarding: OnboardingProvider, private registry: PractitionerRegistry, private opts: PayeeOpts = DEFAULT_PAYEE_OPTS) {}
  private log(m: string) { (this.opts.logger ?? console.log)(m); }

  private async provider(providerId: number, q: Pick<pg.Pool, 'query'> = this.db.pool): Promise<ProviderRow> {
    const r = (await q.query(`SELECT p.id, p.user_id, p.business_name, p.practitioner_type, p.person_name, p.org_name, p.practice_state, p.bar_number, o.tracking_id, o.merchant_id, o.consent_revoked_at, o.action_url, o.referral_mode
                                FROM providers p LEFT JOIN provider_onboarding o ON o.provider_id = p.id WHERE p.id = $1`, [providerId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'provider not found');
    return r;
  }

  // ------------------------------------------------------------------ onboarding
  async startOnboarding(actor: Actor) {
    if (actor.role !== 'provider') throw new HttpError(403, 'forbidden', 'only a provider can start PayPal onboarding');
    const pid = (await this.db.query('SELECT id FROM providers WHERE user_id = $1', [actor.userId])).rows[0]?.id;
    if (!pid) throw new HttpError(403, 'forbidden', 'no provider profile');
    const prov = await this.provider(pid);
    const tracking = prov.tracking_id ?? `gp-provider-${pid}`;
    let action_url = prov.action_url, mode = prov.referral_mode as 'live' | 'simulated' | null, note = 'existing onboarding link';
    if (!(mode === 'live' && action_url)) {
      const r = await this.onboarding.createReferral(tracking, `${this.opts.publicBaseUrl}/paypal/return`);
      if (r.mode === 'live' || !action_url) { action_url = r.action_url; mode = r.mode; note = r.note; }
      else note = `${r.note}; keeping the earlier real onboarding link`;
    }
    await this.db.query(`INSERT INTO provider_onboarding (provider_id, tracking_id, action_url, referral_mode) VALUES ($1,$2,$3,$4)
                         ON CONFLICT (provider_id) DO UPDATE SET action_url = EXCLUDED.action_url, referral_mode = EXCLUDED.referral_mode, updated_at = now()`, [pid, tracking, action_url, mode]);
    await audit(this.db.pool, { actor: actorLabel(actor), action: 'payee.onboarding_started', targetType: 'provider', targetId: String(pid), before: null, after: { tracking_id: tracking, referral_mode: mode, has_action_url: !!action_url, note } });
    this.log(`payee onboarding provider=${pid} referral_mode=${mode}${mode === 'simulated' ? ' (SIMULATED)' : ' (real PayPal sandbox partner referral)'}`);
    return { provider_id: pid, tracking_id: tracking, referral_mode: mode, simulated: mode === 'simulated', action_url, note,
      next_en: action_url ? 'Open action_url to complete PayPal seller onboarding. PayPal will notify us (MERCHANT.ONBOARDING.COMPLETED) when done.' : 'SIMULATED onboarding: no PayPal link was created.',
      next_es: action_url ? 'Abra action_url para completar la incorporación como vendedor en PayPal. PayPal nos avisará (MERCHANT.ONBOARDING.COMPLETED) al terminar.' : 'Incorporación SIMULADA: no se creó ningún enlace de PayPal.' };
  }

  // ------------------------------------------------------------------ verification (both checks, stored as an append-only snapshot)
  async verifyProvider(providerId: number, o: { merchantId?: string | null; reuse?: boolean; trigger?: string } = {}): Promise<VerifyOut> {
    const prov = await this.provider(providerId);
    const merchant = o.merchantId !== undefined ? o.merchantId : prov.merchant_id;
    if (o.reuse) {
      const row = (await this.db.query(`SELECT * FROM provider_verifications WHERE provider_id = $1 AND merchant_id IS NOT DISTINCT FROM $2 AND checked_at > now() - make_interval(secs => $3::int) ORDER BY id DESC LIMIT 1`,
        [providerId, merchant, Math.max(0, Math.floor(this.opts.refreshSeconds))])).rows[0];
      if (row && !prov.consent_revoked_at) return this.format(prov, row, true);
    }
    const tracking = prov.tracking_id ?? `gp-provider-${providerId}`;
    let paypal: PayPalCheck; let snap: unknown = null;
    if (prov.consent_revoked_at && (merchant === prov.merchant_id)) {
      paypal = evaluatePayPal(null, 'none', { en: 'The seller revoked Guardian Pay’s permission in PayPal (MERCHANT.PARTNER-CONSENT.REVOKED). Funds are frozen until they onboard again.', es: 'El vendedor revocó el permiso de Guardian Pay en PayPal (MERCHANT.PARTNER-CONSENT.REVOKED). Los fondos están congelados hasta que se incorpore de nuevo.' });
    } else if (!merchant) {
      paypal = evaluatePayPal(null, 'none');
    } else {
      const st = await this.onboarding.status(tracking, merchant);
      paypal = evaluatePayPal(st.doc, st.mode, st.doc ? undefined : { en: 'PayPal has no onboarding status for this merchant id yet (the seller may not have finished onboarding).', es: 'PayPal aún no tiene estado de incorporación para este id de comerciante (el vendedor puede no haber terminado).' });
      snap = redactStatus(st.doc);
    }
    const pr = this.registry.check({ type: prov.practitioner_type, person_name: prov.person_name, org_name: prov.org_name, practice_state: prov.practice_state, bar_number: prov.bar_number });
    const practice: PracticeOut = { id: 'authorized_to_practice', label_en: 'Authorized to practice immigration law', label_es: 'Autorizado para ejercer derecho migratorio', ...pr, source: pr.route === 'attorney_bar_simulated' ? 'SIMULATED bar lookup + EOIR disciplined lists (snapshot)' : 'DOJ EOIR Recognized Organizations & Accredited Representatives roster + EOIR disciplined lists (snapshot)' };
    const verified = paypal.status === 'pass' && practice.status === 'pass';
    const checks = [paypal, practice];
    const ins = (await this.db.query(`INSERT INTO provider_verifications (provider_id, merchant_id, paypal_mode, paypal_status, practice_status, verified, checks, paypal_snapshot, registry_dates, trigger_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [providerId, merchant, paypal.mode, paypal.status, practice.status, verified, JSON.stringify(checks), JSON.stringify(snap), JSON.stringify(pr.details.snapshot), o.trigger ?? null])).rows[0];
    this.log(`payee verify provider=${providerId} merchant=${maskMerchant(merchant)} paypal=${paypal.status}(${paypal.mode}${paypal.simulated ? ', SIMULATED' : ''}) practice=${practice.status}${practice.simulated ? '(SIMULATED)' : ''} verified=${verified} trigger=${o.trigger ?? '-'}`);
    return this.format(prov, ins, false);
  }

  private format(prov: ProviderRow, row: any, reused: boolean): VerifyOut {
    const checks = row.checks as [PayPalCheck, PracticeOut];
    const verified = !!row.verified;
    const snapshot = row.registry_dates ?? this.registry.check({ type: 'none', person_name: null, org_name: null, practice_state: null, bar_number: null }).details.snapshot;
    const bad = checks.filter(c => c.status !== 'pass');
    return {
      provider_id: prov.id, display_name: prov.business_name, verified, checks, checked_at: new Date(row.checked_at).toISOString(), source: PAYPAL_SOURCE,
      sources: [PAYPAL_SOURCE, checks[1].source], paypal_mode: row.paypal_mode, simulated: !!checks[0].simulated || !!checks[1].simulated, merchant_id_masked: maskMerchant(row.merchant_id),
      snapshot, bar_lookup_url: FLORIDA_BAR_LOOKUP, verification_id: Number(row.id), reused,
      summary_en: verified ? 'Verified: PayPal says this account is ready to receive, and the provider is listed as authorized to practice.' : `Not verified: ${bad.map(c => `${c.label_en} — ${c.status === 'needs_review' ? 'needs human review' : 'failed'}`).join('; ')}.`,
      summary_es: verified ? 'Verificado: PayPal indica que esta cuenta está lista para recibir y el proveedor figura como autorizado para ejercer.' : `No verificado: ${bad.map(c => `${c.label_es} — ${c.status === 'needs_review' ? 'requiere revisión humana' : 'no aprobado'}`).join('; ')}.`,
      disclaimer_en: DISCLAIMER_EN, disclaimer_es: DISCLAIMER_ES };
  }

  /** public read: reuses a snapshot younger than refreshSeconds so the endpoint cannot be used to hammer PayPal */
  async publicVerify(providerId: number) {
    if (!Number.isInteger(providerId) || providerId < 1) throw new HttpError(404, 'not_found', 'provider not found');
    return this.verifyProvider(providerId, { reuse: true, trigger: 'public GET' });
  }
  async verifyMerchant(actor: Actor, providerId: number, merchantId: unknown) {
    if (typeof merchantId !== 'string' || !MERCHANT_RE.test(merchantId)) throw new HttpError(400, 'bad_request', 'merchant_id must be 8-24 letters/digits');
    const prov = await this.provider(providerId);
    if (!(actor.role === 'reviewer' || actor.role === 'system' || (actor.role === 'provider' && actor.userId === prov.user_id))) throw new HttpError(403, 'forbidden', 'not allowed');
    return this.verifyProvider(providerId, { merchantId, trigger: `check by ${actor.label}` });
  }

  // ------------------------------------------------------------------ case binding
  private async bindTx(c: pg.PoolClient, caseId: string, providerId: number, actor: string): Promise<boolean> {
    const o = (await c.query('SELECT merchant_id FROM provider_onboarding WHERE provider_id = $1', [providerId])).rows[0];
    if (!o?.merchant_id) return false;
    const mode = modeOfMerchant(o.merchant_id);
    const r = await c.query(`UPDATE cases SET payee_merchant_id = $2, payee_mode = $3, payee_bound_at = now() WHERE id = $1 AND payee_merchant_id IS NULL`, [caseId, o.merchant_id, mode]);
    if (r.rowCount) await audit(c, { actor, action: 'payee.bound', targetType: 'case', targetId: caseId, caseId, before: { payee_merchant_id: null }, after: { payee_merchant_id_masked: maskMerchant(o.merchant_id), mode, note: 'payee bound; changing it requires re-verification, a cooling delay and family approval' } });
    return !!r.rowCount;
  }
  /** called inside the createCase transaction */
  bindForNewCase(c: pg.PoolClient, caseId: string, providerId: number, actor: string) { return this.bindTx(c, caseId, providerId, actor); }

  private async caseRow(caseId: string, q: Pick<pg.Pool, 'query'> = this.db.pool) {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new HttpError(404, 'not_found', 'case not found');
    const r = (await q.query(`SELECT c.*, p.user_id AS provider_user_id FROM cases c JOIN providers p ON p.id = c.provider_id WHERE c.id = $1`, [caseId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'case not found');
    return r;
  }

  /** Before any funding or approval: bind if still unbound, refuse while a change is open, and (re)verify both checks. The guard is the backstop. */
  async ensureFundable(caseId: string): Promise<VerifyOut> {
    let cs = await this.caseRow(caseId);
    if (!cs.payee_merchant_id) { await this.db.tx(c => this.bindTx(c, caseId, cs.provider_id, 'system'), caseId); cs = await this.caseRow(caseId); }
    if (!cs.payee_merchant_id) throw new HttpError(409, 'payee_not_verified', 'no payee: the provider has not completed PayPal seller onboarding / el proveedor no ha completado la incorporación en PayPal', { reasons_en: ['No PayPal merchant id is on file for this provider.'], reasons_es: ['No hay un id de comerciante de PayPal registrado para este proveedor.'] });
    const open = (await this.db.query(`SELECT 1 FROM payee_change_requests WHERE case_id = $1 AND status IN ('pending','approved')`, [caseId])).rowCount;
    if (open) throw new HttpError(409, 'payee_change_pending', 'a payee change is pending; funding is frozen until it is applied or cancelled / hay un cambio de beneficiario pendiente; los fondos están congelados');
    const v = await this.verifyProvider(cs.provider_id, { merchantId: cs.payee_merchant_id, reuse: true, trigger: 'before funding' });
    if (!v.verified) throw new HttpError(409, 'payee_not_verified', `${v.summary_en} / ${v.summary_es}`, { checks: v.checks.map(c => ({ id: c.id, status: c.status, reason_en: c.reason_en, reason_es: c.reason_es })), verification_id: v.verification_id });
    return v;
  }
  /** stamps the case's payee onto a payment (inside the transaction that creates it) */
  async stampPayment(c: pg.PoolClient, paymentId: string, caseId: string) {
    await c.query(`UPDATE payments SET payee_merchant_id = cs.payee_merchant_id, payee_mode = cs.payee_mode FROM cases cs WHERE payments.id = $1 AND cs.id = $2 AND payments.payee_merchant_id IS NULL`, [paymentId, caseId]);
  }

  async getCasePayee(caseId: string) {
    const cs = await this.caseRow(caseId);
    const ch = (await this.db.query(`SELECT * FROM payee_change_requests WHERE case_id = $1 ORDER BY requested_at DESC LIMIT 1`, [caseId])).rows[0];
    return { merchant_id_masked: maskMerchant(cs.payee_merchant_id), mode: cs.payee_mode as string | null, simulated: cs.payee_mode === 'simulated', bound_at: cs.payee_bound_at ? new Date(cs.payee_bound_at).toISOString() : null,
      immutable: !!cs.payee_merchant_id, change: ch ? publicChange(ch) : null };
  }

  // ------------------------------------------------------------------ immutable binding: change flow (re-verify -> family approval -> cooling delay -> apply)
  async requestChange(actor: Actor, caseId: string, newMerchant: unknown) {
    const cs = await this.caseRow(caseId);
    if (actor.role !== 'provider' || actor.userId !== cs.provider_user_id) throw new HttpError(403, 'forbidden', 'only the case provider can request a payee change');
    if (typeof newMerchant !== 'string' || !MERCHANT_RE.test(newMerchant)) throw new HttpError(400, 'bad_request', 'new_merchant_id must be 8-24 letters/digits');
    if (newMerchant === cs.payee_merchant_id) throw new HttpError(400, 'bad_request', 'that is already the bound payee');
    const v = await this.verifyProvider(cs.provider_id, { merchantId: newMerchant, trigger: 'payee change request' });
    if (!v.verified) throw new HttpError(409, 'payee_not_verified', `the new payee does not pass both checks. ${v.summary_en} / ${v.summary_es}`, { checks: v.checks.map(c => ({ id: c.id, status: c.status, reason_en: c.reason_en, reason_es: c.reason_es })) });
    const mode = modeOfMerchant(newMerchant);
    const effective = new Date(caseNow(cs.clock_offset_days).getTime() + this.opts.coolingHours * 3_600_000);
    return this.db.tx(async c => {
      const open = (await c.query(`SELECT 1 FROM payee_change_requests WHERE case_id = $1 AND status IN ('pending','approved')`, [caseId])).rowCount;
      if (open) throw new HttpError(409, 'conflict', 'a payee change is already open for this case');
      const r = (await c.query(`INSERT INTO payee_change_requests (case_id, old_merchant_id, new_merchant_id, new_mode, requested_by, effective_after, verification_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [caseId, cs.payee_merchant_id, newMerchant, mode, actorLabel(actor), effective, v.verification_id])).rows[0];
      await audit(c, { actor: actorLabel(actor), action: 'payee.change_requested', targetType: 'case', targetId: caseId, caseId, before: { payee_merchant_id_masked: maskMerchant(cs.payee_merchant_id) },
        after: { new_merchant_id_masked: maskMerchant(newMerchant), mode, effective_after: effective.toISOString(), cooling_hours: this.opts.coolingHours, verification_id: v.verification_id, note: 'funds are frozen until the family approves, the cooling delay passes and the new payee re-verifies' } });
      return publicChange(r);
    }, caseId);
  }
  async approveChange(actor: Actor, caseId: string) {
    const cs = await this.caseRow(caseId);
    if (actor.role !== 'family' || actor.userId !== cs.family_user_id) throw new HttpError(403, 'forbidden', "only the case's family can approve a payee change");
    return this.db.tx(async c => {
      const r = (await c.query(`SELECT * FROM payee_change_requests WHERE case_id = $1 AND status IN ('pending','approved') FOR UPDATE`, [caseId])).rows[0];
      if (!r) throw new HttpError(404, 'not_found', 'no open payee change');
      if (r.status === 'approved') return publicChange(r);
      const u = (await c.query(`UPDATE payee_change_requests SET status = 'approved', family_approved_by = $2, family_approved_at = now() WHERE id = $1 RETURNING *`, [r.id, actor.userId])).rows[0];
      await audit(c, { actor: actorLabel(actor), action: 'payee.change_approved', targetType: 'case', targetId: caseId, caseId, before: { status: 'pending' }, after: { status: 'approved', effective_after: new Date(r.effective_after).toISOString(), note: 'family approved; still waits for the cooling delay and a fresh re-verification' } });
      return publicChange(u);
    }, caseId);
  }
  async cancelChange(actor: Actor, caseId: string) {
    const cs = await this.caseRow(caseId);
    const ok = (actor.role === 'provider' && actor.userId === cs.provider_user_id) || (actor.role === 'family' && actor.userId === cs.family_user_id);
    if (!ok) throw new HttpError(403, 'forbidden', 'only the case provider or family can cancel a payee change');
    return this.db.tx(async c => {
      const r = (await c.query(`UPDATE payee_change_requests SET status = 'cancelled', resolved_at = now() WHERE case_id = $1 AND status IN ('pending','approved') RETURNING *`, [caseId])).rows[0];
      if (!r) throw new HttpError(404, 'not_found', 'no open payee change');
      await audit(c, { actor: actorLabel(actor), action: 'payee.change_cancelled', targetType: 'case', targetId: caseId, caseId, before: { status: 'open' }, after: { status: 'cancelled' } });
      return publicChange(r);
    }, caseId);
  }
  /** Applies an approved change once the (case-clock) cooling delay has passed AND the new payee passes both checks again. */
  async applyChange(actor: Actor, caseId: string) {
    const cs = await this.caseRow(caseId);
    const ok = actor.role === 'system' || (actor.role === 'provider' && actor.userId === cs.provider_user_id) || (actor.role === 'family' && actor.userId === cs.family_user_id);
    if (!ok) throw new HttpError(403, 'forbidden', 'not allowed');
    const r = (await this.db.query(`SELECT * FROM payee_change_requests WHERE case_id = $1 AND status IN ('pending','approved') LIMIT 1`, [caseId])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'no open payee change');
    if (r.status !== 'approved') throw new HttpError(409, 'family_approval_required', 'the family must approve the payee change first');
    const now = caseNow(cs.clock_offset_days);
    if (now.getTime() < new Date(r.effective_after).getTime()) throw new HttpError(409, 'cooling_delay', `cooling delay: can be applied after ${new Date(r.effective_after).toISOString()}`, { effective_after: new Date(r.effective_after).toISOString() });
    const v = await this.verifyProvider(cs.provider_id, { merchantId: r.new_merchant_id, trigger: 'payee change apply' });
    if (!v.verified) {
      await audit(this.db.pool, { actor: actorLabel(actor), action: 'payee.change_blocked', targetType: 'case', targetId: caseId, caseId, before: null, after: { reason: 're-verification failed at apply time', verification_id: v.verification_id } });
      throw new HttpError(409, 'payee_not_verified', `re-verification failed at apply time. ${v.summary_en} / ${v.summary_es}`);
    }
    return this.db.tx(async c => {
      const q = (await c.query(`SELECT * FROM payee_change_requests WHERE id = $1 FOR UPDATE`, [r.id])).rows[0];
      if (q.status !== 'approved') throw new HttpError(409, 'conflict', 'change is no longer open');
      await c.query(`SELECT set_config('gp.payee_change', 'approved', true)`);
      await c.query(`UPDATE cases SET payee_merchant_id = $2, payee_mode = $3, payee_bound_at = now() WHERE id = $1`, [caseId, q.new_merchant_id, q.new_mode]);
      await c.query(`UPDATE payments SET payee_merchant_id = $2, payee_mode = $3 WHERE status = 'pending_order' AND milestone_id IN (SELECT id FROM milestones WHERE case_id = $1)`, [caseId, q.new_merchant_id, q.new_mode]);
      const u = (await c.query(`UPDATE payee_change_requests SET status = 'applied', resolved_at = now() WHERE id = $1 RETURNING *`, [q.id])).rows[0];
      await audit(c, { actor: actorLabel(actor), action: 'payee.change_applied', targetType: 'case', targetId: caseId, caseId, before: { payee_merchant_id_masked: maskMerchant(q.old_merchant_id) },
        after: { payee_merchant_id_masked: maskMerchant(q.new_merchant_id), mode: q.new_mode, verification_id: v.verification_id, family_approved_at: q.family_approved_at, note: 'payments already authorized to the previous payee cannot be captured; void and re-fund' } });
      return publicChange(u);
    }, caseId);
  }
  /** background: apply approved changes whose cooling delay has passed (on each case's own clock) */
  async tickChanges(): Promise<{ applied: number; blocked: number }> {
    const rows = (await this.db.query(`SELECT r.case_id FROM payee_change_requests r WHERE r.status = 'approved'`)).rows;
    let applied = 0, blocked = 0; const SYS: Actor = { userId: null, role: 'system', label: 'system' };
    for (const { case_id } of rows) {
      try { const cs = await this.caseRow(case_id); const r = (await this.db.query(`SELECT effective_after FROM payee_change_requests WHERE case_id = $1 AND status = 'approved'`, [case_id])).rows[0];
        if (!r || caseNow(cs.clock_offset_days).getTime() < new Date(r.effective_after).getTime()) continue;
        await this.applyChange(SYS, case_id); applied++;
      } catch (e) { blocked++; this.log('payee change not applied: ' + (e as Error).message); }
    }
    return { applied, blocked };
  }

  // ------------------------------------------------------------------ webhooks
  async handleWebhook(type: string, payload: any): Promise<string> {
    const r = payload?.resource ?? {};
    const tracking = typeof r.tracking_id === 'string' ? r.tracking_id : null; const mid = typeof r.merchant_id === 'string' ? r.merchant_id : null;
    const row = (await this.db.query(`SELECT * FROM provider_onboarding WHERE ($1::text IS NOT NULL AND tracking_id = $1) OR ($2::text IS NOT NULL AND merchant_id = $2) LIMIT 1`, [tracking, mid])).rows[0];
    if (!row) return 'no matching provider';
    if (type === 'MERCHANT.ONBOARDING.COMPLETED') {
      // never overwrite a real (live) merchant id with another; fill in a missing or simulated one
      if (mid && MERCHANT_RE.test(mid) && (!row.merchant_id || modeOfMerchant(row.merchant_id) === 'simulated'))
        await this.db.query(`UPDATE provider_onboarding SET merchant_id = $2, referral_mode = 'live', consent_revoked_at = NULL, updated_at = now() WHERE provider_id = $1`, [row.provider_id, mid]);
      else await this.db.query(`UPDATE provider_onboarding SET consent_revoked_at = NULL, updated_at = now() WHERE provider_id = $1`, [row.provider_id]);
      const v = await this.verifyProvider(row.provider_id, { trigger: `webhook ${type}` });
      const bound = await this.db.tx(async c => { const cases = (await c.query(`SELECT id FROM cases WHERE provider_id = $1 AND payee_merchant_id IS NULL`, [row.provider_id])).rows; let n = 0; for (const k of cases) if (await this.bindTx(c, k.id, row.provider_id, `webhook(${type})`)) n++; return n; });
      await audit(this.db.pool, { actor: `webhook(${type})`, action: 'payee.onboarding_completed', targetType: 'provider', targetId: String(row.provider_id), before: null, after: { verified: v.verified, verification_id: v.verification_id, cases_bound: bound } });
      return `onboarding completed; verified=${v.verified}; cases bound=${bound}`;
    }
    if (type === 'MERCHANT.PARTNER-CONSENT.REVOKED') {
      await this.db.query(`UPDATE provider_onboarding SET consent_revoked_at = now(), updated_at = now() WHERE provider_id = $1`, [row.provider_id]);
      const v = await this.verifyProvider(row.provider_id, { trigger: `webhook ${type}` });
      await audit(this.db.pool, { actor: `webhook(${type})`, action: 'payee.consent_revoked', targetType: 'provider', targetId: String(row.provider_id), before: null, after: { verified: v.verified, verification_id: v.verification_id, note: 'funds to this payee are frozen' } });
      return `consent revoked; verified=${v.verified}`;
    }
    return 'ignored';
  }
}

export const publicChange = (r: any) => ({ id: r.id, case_id: r.case_id, status: r.status as string, old_merchant_id_masked: maskMerchant(r.old_merchant_id), new_merchant_id_masked: maskMerchant(r.new_merchant_id), new_mode: r.new_mode as string,
  requested_by: r.requested_by as string, requested_at: new Date(r.requested_at).toISOString(), effective_after: new Date(r.effective_after).toISOString(), family_approved_at: r.family_approved_at ? new Date(r.family_approved_at).toISOString() : null,
  resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null });
