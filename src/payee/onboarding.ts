import type { PayPalClient } from '../paypal.js';
import { REQUIRED_SCOPES, type PayPalStatusDoc } from './paypalStatus.js';

export type OnboardingMode = 'live' | 'simulated';
export interface ReferralResult { mode: OnboardingMode; action_url: string | null; note: string }
export interface StatusResult { mode: OnboardingMode | 'none'; doc: PayPalStatusDoc | null; merchant_id: string | null; note: string }
export interface OnboardingProvider {
  /** POST /v2/customer/partner-referrals. Real call against the PayPal SANDBOX when credentials exist; tracking_id = our provider id. */
  createReferral(trackingId: string, returnUrl: string): Promise<ReferralResult>;
  /** Seller onboarding status for a provider (by tracking id / merchant id). */
  status(trackingId: string, merchantId: string | null): Promise<StatusResult>;
}

/** SIMULATED PayPal-shaped status. merchant ids: SIMOK... = fully onboarded; SIMBAD... = not ready; anything else = unknown (no status). No PayPal account is behind these ids. */
export function simulatedStatus(merchantId: string | null, trackingId: string): PayPalStatusDoc | null {
  if (!merchantId || !/^SIM(OK|BAD)/.test(merchantId)) return null;
  const ok = merchantId.startsWith('SIMOK');
  return { merchant_id: merchantId, tracking_id: trackingId, payments_receivable: ok, primary_email_confirmed: ok, legal_name: 'SIMULATED seller',
    products: [{ name: 'PPCP', vetting_status: ok ? 'SUBSCRIBED' : 'NEED_MORE_DATA' }],
    oauth_integrations: [{ integration_type: 'OAUTH_THIRD_PARTY', oauth_third_party: [{ partner_client_id: 'SIMULATED', scopes: ok ? ['https://uri.paypal.com/services/payments/realtimepayment', `https://uri.paypal.com/services${REQUIRED_SCOPES.authcapture}`, `https://uri.paypal.com/services${REQUIRED_SCOPES.refund}`] : [] }] }] };
}

export class SimulatedOnboarding implements OnboardingProvider {
  async createReferral(trackingId: string): Promise<ReferralResult> { return { mode: 'simulated', action_url: null, note: `SIMULATED sandbox onboarding (no PayPal call) for ${trackingId}` }; }
  async status(trackingId: string, merchantId: string | null): Promise<StatusResult> {
    const doc = simulatedStatus(merchantId, trackingId);
    return { mode: doc ? 'simulated' : 'none', doc, merchant_id: merchantId, note: doc ? 'SIMULATED sandbox onboarding status (PayPal-shaped)' : 'no onboarding status available' };
  }
}

/**
 * REAL PayPal sandbox adapter.
 *  - createReferral: real POST /v2/customer/partner-referrals (works in sandbox; returns the hosted onboarding link for the provider).
 *  - status: real GET merchant-integrations, but only after the seller finished PayPal's hosted onboarding AND PAYPAL_PARTNER_MERCHANT_ID is set.
 *    If the real status is not available, it falls back to the SIMULATED status for sandbox demo merchants (SIMOK/SIMBAD ids), labeled mode=simulated.
 */
export class LivePayPalOnboarding implements OnboardingProvider {
  private sim = new SimulatedOnboarding();
  constructor(private client: PayPalClient, private partnerMerchantId: string | null, private logger: (m: string) => void = console.log) {}
  async createReferral(trackingId: string, returnUrl: string): Promise<ReferralResult> {
    const r = await this.client.createPartnerReferral({ tracking_id: trackingId,
      operations: [{ operation: 'API_INTEGRATION', api_integration_preference: { rest_api_integration: { integration_method: 'PAYPAL', integration_type: 'THIRD_PARTY', third_party_details: { features: ['PAYMENT', 'REFUND', 'PARTNER_FEE', 'DELAY_FUNDS_DISBURSEMENT'] } } } }],
      products: ['PPCP'], legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }], partner_config_override: { return_url: returnUrl } });
    if (r.status >= 300) { this.logger(`partner-referrals failed ${r.status} ${r.body?.name ?? ''}`); return { mode: 'simulated', action_url: null, note: `PayPal Partner Referrals unavailable (${r.status}); SIMULATED instead` }; }
    const url = (r.body?.links ?? []).find((l: any) => l.rel === 'action_url')?.href ?? null;
    return { mode: 'live', action_url: url, note: 'REAL PayPal sandbox partner referral created' };
  }
  async status(trackingId: string, merchantId: string | null): Promise<StatusResult> {
    if (this.partnerMerchantId) {
      try {
        let mid = merchantId && !/^SIM/.test(merchantId) ? merchantId : null;
        if (!mid) { const t = await this.client.getMerchantByTracking(this.partnerMerchantId, trackingId); if (t.status < 300 && t.body?.merchant_id) mid = String(t.body.merchant_id); }
        if (mid) { const s = await this.client.getMerchantStatus(this.partnerMerchantId, mid); if (s.status < 300) return { mode: 'live', doc: { ...s.body, merchant_id: s.body?.merchant_id ?? mid }, merchant_id: mid, note: 'REAL PayPal sandbox seller onboarding status' }; }
      } catch (e) { this.logger('live onboarding status error: ' + (e as Error).message); }
    }
    return this.sim.status(trackingId, merchantId);
  }
}
