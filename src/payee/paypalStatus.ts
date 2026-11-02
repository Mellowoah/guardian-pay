/** Evaluates a PayPal "seller onboarding status" document (real GET merchant-integrations response, or a SIMULATED one of the same shape). */
export const REQUIRED_SCOPES = { authcapture: '/payments/payment/authcapture', refund: '/payments/refund' } as const;
export type SubStatus = 'pass' | 'fail';
export interface PayPalStatusDoc { merchant_id?: string; tracking_id?: string; payments_receivable?: boolean; primary_email_confirmed?: boolean; legal_name?: string; products?: { name: string; vetting_status?: string }[]; oauth_integrations?: { integration_type?: string; oauth_third_party?: { scopes?: string[]; partner_client_id?: string }[] }[] }
export interface PayPalCheck {
  id: 'paypal_ready'; status: 'pass' | 'fail'; mode: 'live' | 'simulated' | 'none'; simulated: boolean; source: string;
  label_en: string; label_es: string; reason_en: string; reason_es: string;
  details: { sub_checks: { id: string; status: SubStatus; reason_en: string; reason_es: string }[] };
}
export const PAYPAL_SOURCE = 'PayPal seller onboarding status';

export function scopesOf(doc: PayPalStatusDoc): string[] { return (doc.oauth_integrations ?? []).flatMap(i => (i.oauth_third_party ?? []).flatMap(t => t.scopes ?? [])); }

/** pass only if payments_receivable AND primary_email_confirmed AND the authorize/capture + refund permissions were granted to us. Mirrors PayPal's own flags; it does not prove who someone is. */
export function evaluatePayPal(doc: PayPalStatusDoc | null, mode: 'live' | 'simulated' | 'none', why?: { en: string; es: string }): PayPalCheck {
  const label = { label_en: 'PayPal account ready to receive payments', label_es: 'Cuenta de PayPal lista para recibir pagos' };
  const sim = mode === 'simulated';
  const tag = sim ? ' (SIMULATED sandbox onboarding status)' : '';
  const tagEs = sim ? ' (estado de incorporación SIMULADO del sandbox)' : '';
  if (!doc) return { id: 'paypal_ready', status: 'fail', mode, simulated: sim, source: PAYPAL_SOURCE, ...label,
    reason_en: why?.en ?? 'This provider has not completed PayPal seller onboarding, so no PayPal status is available.', reason_es: why?.es ?? 'Este proveedor no ha completado la incorporación como vendedor en PayPal, por lo que no hay estado disponible.', details: { sub_checks: [] } };
  const scopes = scopesOf(doc);
  const has = (suffix: string) => scopes.some(s => s.endsWith(suffix));
  const sub = [
    { id: 'payments_receivable', ok: doc.payments_receivable === true, en: ['PayPal says the account can receive payments.', 'PayPal indica que la cuenta puede recibir pagos.'], bad: ['PayPal says the account cannot receive payments yet.', 'PayPal indica que la cuenta todavía no puede recibir pagos.'] },
    { id: 'primary_email_confirmed', ok: doc.primary_email_confirmed === true, en: ['The account email is confirmed.', 'El correo de la cuenta está confirmado.'], bad: ['The account email is not confirmed.', 'El correo de la cuenta no está confirmado.'] },
    { id: 'permissions', ok: has(REQUIRED_SCOPES.authcapture) && has(REQUIRED_SCOPES.refund), en: ['The seller granted Guardian Pay the payment-authorize/capture and refund permissions.', 'El vendedor otorgó a Guardian Pay los permisos de autorizar/capturar pagos y reembolsos.'], bad: ['The seller has not granted the required payment and refund permissions.', 'El vendedor no ha otorgado los permisos de pago y reembolso necesarios.'] },
  ].map(x => ({ id: x.id, status: (x.ok ? 'pass' : 'fail') as SubStatus, reason_en: x.ok ? x.en[0] : x.bad[0], reason_es: x.ok ? x.en[1] : x.bad[1] }));
  const ok = sub.every(x => x.status === 'pass');
  return { id: 'paypal_ready', status: ok ? 'pass' : 'fail', mode, simulated: sim, source: PAYPAL_SOURCE, ...label,
    reason_en: (ok ? 'Verified by PayPal as ready to receive: payments receivable, email confirmed, permissions granted.' : 'Not ready: ' + sub.filter(x => x.status === 'fail').map(x => x.reason_en).join(' ')) + tag,
    reason_es: (ok ? 'Verificado por PayPal como listo para recibir: pagos habilitados, correo confirmado, permisos otorgados.' : 'No está listo: ' + sub.filter(x => x.status === 'fail').map(x => x.reason_es).join(' ')) + tagEs,
    details: { sub_checks: sub } };
}

/** the redacted subset we store (no legal names or contact data) */
export const redactStatus = (d: PayPalStatusDoc | null) => d ? { merchant_id: d.merchant_id, tracking_id: d.tracking_id, payments_receivable: d.payments_receivable, primary_email_confirmed: d.primary_email_confirmed, scopes: scopesOf(d), products: (d.products ?? []).map(p => ({ name: p.name, vetting_status: p.vetting_status })) } : null;
