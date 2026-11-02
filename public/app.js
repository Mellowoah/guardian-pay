// Guardian Pay thin UI: plain JS, no build step. Every money action calls the guard-backed API; nothing here touches PayPal money directly
// except the PayPal JS SDK popup, whose createOrder/onApprove call our own endpoints. All data is rendered with textContent (no innerHTML).
// DOM append/prepend that skip null/false (so conditional children are easy) and flatten arrays
for (const fn of ['append', 'prepend']) { const orig = Element.prototype[fn]; Element.prototype[fn] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); }; }
const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

// ------------------------------------------------------------------ i18n
const T = {
  en: {
    tagline: 'Guarded Agent Payments on PayPal', featured: 'Featured demo: MilestonePay (immigration help)',
    disclaimer: '<b>Guardian Pay mirrors PayPal\'s checks and public practitioner lists. It is not a legal determination, not legal advice, and not a law firm.</b> Sandbox demo: synthetic people and documents, fake money. Parts marked SIMULATED are simulations.',
    signin: 'Sign in with a demo token', tokenHelp: 'Demo logins are bearer tokens for the synthetic actors (family, provider, reviewer). Paste one, or open a login link.', token: 'Bearer token', signinBtn: 'Sign in', signout: 'Sign out', badToken: 'That token was not accepted.',
    role_family: 'Payer / family', role_provider: 'Provider', role_reviewer: 'Reviewer',
    heroTitle: 'The AI suggests. A human decides. PayPal moves the money.', heroP1: 'Guardian Pay places a PayPal hold for each step of a job and only collects it after the payee checks out and people have approved the proof. No code path, including an AI agent, can collect without a recorded human approval.',
    real: 'Real in this demo', sim: 'SIMULATED in this demo', planned: 'Planned',
    realList: ['PayPal sandbox orders: authorize, capture, void (the real PayPal popup)', 'The guard: one money path, idempotent, audit log', 'AI proof read (fields only) + fixed-rule checks + human approval bound to the proof file', 'DOJ EOIR roster and discipline snapshot (dated)'],
    simList: ['PayPal seller onboarding STATUS for the demo payees (the referral link itself is a real sandbox call)', 'Attorney bar lookup (fixture records; link to the official lookup)'],
    plannedList: ['Signed payer limits (mandate)', 'Agent API for other platforms'],
    cases: 'Cases', noCases: 'No cases yet.', open: 'Open', back: '← All cases', newCase: 'Create a synthetic demo case', creating: 'Creating…',
    payee: 'Who gets paid: payee verification', verified: 'Verified', notVerified: 'Not verified', needsReview: 'Needs review', pass: 'Pass', fail: 'Fail', needs_review: 'Needs review', not_run: 'Not run',
    simulatedTag: 'SIMULATED', snapshot: 'Snapshot dates', roster: 'EOIR roster report', discipline: 'Currently-disciplined list', checkedAt: 'Checked', bound: 'Payee bound to this case', merchant: 'PayPal merchant', locked: 'locked: changing it needs re-verification, a cooling delay and family approval',
    org: 'Organization', accExp: 'Accreditation expires', recExp: 'Recognition expires', pending: 'pending renewal (asterisk on the EOIR roster)', barLink: 'Official Florida Bar lookup (manual check)', viaSim: 'Attorney lookup is SIMULATED',
    milestones: 'Milestones', amount: 'Amount', state: 'State', fund: 'Fund with PayPal', fundHelp: 'Opens the PayPal sandbox popup. Funds are only held (authorized), not collected.', funded: 'Funded: held by PayPal, not yet collected.',
    waitingProof: 'Waiting for the provider to upload proof.', waitingReview: 'Proof uploaded. Waiting for the reviewer to verify.', verifiedBy: 'Verified by', proofToApprove: 'Proof you are approving', sha: 'Proof sha256', approve: 'Approve and release this payment', approveHelp: 'Your approval is bound to this exact proof file. If the file changes, the approval is refused.',
    reject: 'Reject (void the hold)', reason: 'Reason', captured: 'Collected', capture: 'Capture id', voided: 'Hold voided; nothing was collected.', expired: 'Hold expired.',
    aiCheck: 'AI proof check (advisory only)', aiNever: 'Advisory only. It never approves or changes the payment. A reviewer verifies and the family approves.', score: 'Score', recommendation: 'Recommendation', checksTitle: 'Checks',
    rec_recommend_approve: 'Looks consistent: recommend approve', rec_needs_human_review: 'Needs human review', rec_recommend_reject: 'Looks inconsistent: recommend reject', noCheck: 'No AI check result yet.',
    upload: 'Upload proof', file: 'Proof image (PNG/JPEG/WebP)', note: 'Note (optional)', useSample: 'Use the synthetic sample receipt', submit: 'Submit proof', submitted: 'Proof submitted.',
    verifyBtn: 'Mark proof verified (not an approval)', verifyHelp: 'You verify; only the family can approve and release funds.', verifyNote: 'Reviewer note (optional)',
    onboarding: 'Start PayPal seller onboarding', onbDone: 'Onboarding link (real PayPal sandbox call)', onbSim: 'Labeled SIMULATED fallback',
    audit: 'Audit trail', loading: 'Loading…', error: 'Something went wrong', refresh: 'Refresh', auto: 'No automatic approvals exist.',
    s_created: 'Not funded', s_authorized: 'Funded (held)', s_reauthorized: 'Funded (re-held)', s_proof_submitted: 'Proof submitted', s_verified: 'Verified by reviewer', s_captured: 'Collected', s_rejected: 'Rejected', s_voided: 'Voided', s_expired: 'Expired',
    cancelled: 'PayPal popup closed; nothing was held.', popupNote: 'PayPal sandbox popup: sign in with a sandbox buyer account.',
    payeeBlocked: 'Funding is blocked until the payee passes both checks.', provider: 'Provider', beneficiary: 'Beneficiary', type: 'Case type',
  },
  es: {
    tagline: 'Pagos guiados para agentes en PayPal', featured: 'Demo destacada: MilestonePay (ayuda migratoria)',
    disclaimer: '<b>Guardian Pay refleja las verificaciones de PayPal y las listas públicas de profesionales. No es una determinación legal, ni asesoría legal, ni un bufete.</b> Demo en sandbox: personas y documentos sintéticos, dinero falso. Lo marcado SIMULADO es una simulación.',
    signin: 'Entrar con un token de demostración', tokenHelp: 'Los accesos de demostración son tokens para los actores sintéticos (familia, proveedor, revisor). Pegue uno o abra un enlace de acceso.', token: 'Token', signinBtn: 'Entrar', signout: 'Salir', badToken: 'No se aceptó ese token.',
    role_family: 'Pagador / familia', role_provider: 'Proveedor', role_reviewer: 'Revisor',
    heroTitle: 'La IA sugiere. Una persona decide. PayPal mueve el dinero.', heroP1: 'Guardian Pay pone una retención de PayPal por cada etapa de un trabajo y solo la cobra cuando el beneficiario es verificado y personas han aprobado la prueba. Ninguna ruta de código, ni un agente de IA, puede cobrar sin una aprobación humana registrada.',
    real: 'Real en esta demo', sim: 'SIMULADO en esta demo', planned: 'Planeado',
    realList: ['Órdenes en el sandbox de PayPal: autorizar, capturar, anular (la ventana real de PayPal)', 'El guardián: una sola ruta de dinero, idempotente, registro de auditoría', 'Lectura de la prueba por IA (solo campos) + reglas fijas + aprobación humana ligada al archivo', 'Instantánea fechada de la lista y disciplina de EOIR (DOJ)'],
    simList: ['ESTADO de incorporación de vendedor de PayPal de los beneficiarios demo (el enlace de incorporación sí es una llamada real al sandbox)', 'Consulta de abogados (registros de prueba; enlace a la consulta oficial)'],
    plannedList: ['Límites firmados por el pagador (mandato)', 'API de agentes para otras plataformas'],
    cases: 'Casos', noCases: 'Aún no hay casos.', open: 'Abrir', back: '← Todos los casos', newCase: 'Crear un caso de demostración sintético', creating: 'Creando…',
    payee: 'A quién se paga: verificación del beneficiario', verified: 'Verificado', notVerified: 'No verificado', needsReview: 'Requiere revisión', pass: 'Aprobado', fail: 'Falla', needs_review: 'Requiere revisión', not_run: 'No ejecutado',
    simulatedTag: 'SIMULADO', snapshot: 'Fechas de las instantáneas', roster: 'Informe de la lista EOIR', discipline: 'Lista de disciplinados actuales', checkedAt: 'Verificado', bound: 'Beneficiario fijado a este caso', merchant: 'Comerciante de PayPal', locked: 'bloqueado: cambiarlo requiere nueva verificación, una espera y la aprobación de la familia',
    org: 'Organización', accExp: 'La acreditación vence', recExp: 'El reconocimiento vence', pending: 'renovación pendiente (asterisco en la lista de EOIR)', barLink: 'Consulta oficial del Colegio de Abogados de Florida (verificación manual)', viaSim: 'La consulta de abogados es SIMULADA',
    milestones: 'Etapas', amount: 'Monto', state: 'Estado', fund: 'Pagar con PayPal', fundHelp: 'Abre la ventana del sandbox de PayPal. Los fondos solo se retienen (autorizan), no se cobran.', funded: 'Financiado: retenido por PayPal, aún no cobrado.',
    waitingProof: 'Esperando que el proveedor suba la prueba.', waitingReview: 'Prueba subida. Esperando la verificación del revisor.', verifiedBy: 'Verificado por', proofToApprove: 'Prueba que usted aprueba', sha: 'sha256 de la prueba', approve: 'Aprobar y liberar este pago', approveHelp: 'Su aprobación queda ligada a este archivo exacto. Si el archivo cambia, se rechaza la aprobación.',
    reject: 'Rechazar (anular la retención)', reason: 'Motivo', captured: 'Cobrado', capture: 'Id de captura', voided: 'Retención anulada; no se cobró nada.', expired: 'La retención venció.',
    aiCheck: 'Verificación de la prueba por IA (solo orientativa)', aiNever: 'Solo orientativa. Nunca aprueba ni cambia el pago. Un revisor verifica y la familia aprueba.', score: 'Puntuación', recommendation: 'Recomendación', checksTitle: 'Verificaciones',
    rec_recommend_approve: 'Parece coherente: se recomienda aprobar', rec_needs_human_review: 'Requiere revisión humana', rec_recommend_reject: 'Parece incoherente: se recomienda rechazar', noCheck: 'Aún no hay resultado de la IA.',
    upload: 'Subir prueba', file: 'Imagen de la prueba (PNG/JPEG/WebP)', note: 'Nota (opcional)', useSample: 'Usar el recibo de muestra sintético', submit: 'Enviar prueba', submitted: 'Prueba enviada.',
    verifyBtn: 'Marcar prueba como verificada (no es una aprobación)', verifyHelp: 'Usted verifica; solo la familia puede aprobar y liberar los fondos.', verifyNote: 'Nota del revisor (opcional)',
    onboarding: 'Iniciar incorporación de vendedor en PayPal', onbDone: 'Enlace de incorporación (llamada real al sandbox de PayPal)', onbSim: 'Alternativa SIMULADA y rotulada',
    audit: 'Registro de auditoría', loading: 'Cargando…', error: 'Algo salió mal', refresh: 'Actualizar', auto: 'No existen aprobaciones automáticas.',
    s_created: 'Sin financiar', s_authorized: 'Financiado (retenido)', s_reauthorized: 'Financiado (retenido de nuevo)', s_proof_submitted: 'Prueba enviada', s_verified: 'Verificado por el revisor', s_captured: 'Cobrado', s_rejected: 'Rechazado', s_voided: 'Anulado', s_expired: 'Vencido',
    cancelled: 'Se cerró la ventana de PayPal; no se retuvo nada.', popupNote: 'Ventana del sandbox de PayPal: entre con una cuenta compradora de sandbox.',
    payeeBlocked: 'El pago está bloqueado hasta que el beneficiario apruebe ambas verificaciones.', provider: 'Proveedor', beneficiary: 'Beneficiario', type: 'Tipo de caso',
  },
};
const CHECK_NAMES = {
  receipt_format: ['Receipt number format', 'Formato del número de recibo'], form_type_match: ['Form type matches the milestone', 'El tipo de formulario coincide con la etapa'], notice_date_valid: ['Notice date is plausible', 'La fecha del aviso es plausible'],
  beneficiary_match: ['Beneficiary name matches the case', 'El nombre del beneficiario coincide con el caso'], document_type_match: ['Document type matches', 'El tipo de documento coincide'], legibility: ['Image is legible', 'La imagen es legible'], proof_not_reused: ['Proof not used on another case', 'La prueba no se usó en otro caso'],
};
let lang = localStorage.getItem('gp_lang') || (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
if (localStorage.getItem('gp_lang')) lang = localStorage.getItem('gp_lang');
const t = (k) => T[lang][k] ?? T.en[k] ?? k;
const L = (o, k) => (lang === 'es' ? o?.[k + '_es'] : o?.[k + '_en']) ?? o?.[k + '_en'] ?? '';

// ------------------------------------------------------------------ auth (bearer tokens; kept per role in this browser tab only)
const store = { get: () => { try { return JSON.parse(sessionStorage.getItem('gp_tokens') || '{}'); } catch { return {}; } }, set: (v) => sessionStorage.setItem('gp_tokens', JSON.stringify(v)) };
let current = sessionStorage.getItem('gp_role') || null;
const ROLE_ORDER = ['family', 'provider', 'reviewer'];

async function api(method, path, body, role = current) {
  const tok = store.get()[role];
  const res = await fetch(path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {}; try { json = await res.json(); } catch { /* not json */ }
  if (!res.ok) { const e = new Error(json.message || json.error || `HTTP ${res.status}`); Object.assign(e, { status: res.status, code: json.error, data: json }); throw e; }
  return json;
}
async function addToken(tok) {
  const res = await fetch('/api/me', { headers: { authorization: 'Bearer ' + tok } });
  if (!res.ok) return false;
  const me = await res.json();
  if (!ROLE_ORDER.includes(me.role)) return false;
  const s = store.get(); s[me.role] = tok; store.set(s); current = me.role; sessionStorage.setItem('gp_role', current); return true;
}

// ------------------------------------------------------------------ small widgets
const badge = (status, text) => h('span', { class: 'badge b-' + status }, text ?? t(status));
const simTag = () => h('span', { class: 'badge b-sim', title: 'SIMULATED' }, t('simulatedTag'));
const errBox = (e) => {
  const extra = e.data?.checks ? h('ul', { class: 'clean' }, e.data.checks.map((c) => h('li', {}, `${c.id}: ${c.status} — ${L(c, 'reason')}`))) : null;
  return h('div', { class: 'notice n-err', role: 'alert' }, `${e.message}`, extra);
};
let flash = null;
function setFlash(kind, text) { flash = { kind, text }; }
const flashBox = () => { if (!flash) return null; const f = flash; flash = null; return h('div', { class: 'notice n-' + f.kind }, f.text); };
const fmtDate = (s) => (s ? new Date(s).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : '');
const short = (s, n = 12) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? '');

// ------------------------------------------------------------------ payee panel (public verify-payee)
async function payeePanel(providerId, casePayee) {
  const box = h('section', { class: 'card', 'data-testid': 'payee-panel' }, h('h2', {}, t('payee')), h('p', { class: 'muted' }, t('loading')));
  try {
    const v = await (await fetch(`/api/verify-payee/${providerId}`)).json();
    const needsReview = v.checks?.some((c) => c.status === 'needs_review');
    const overall = v.verified ? badge('pass', '✓ ' + t('verified')) : needsReview ? badge('needs_review', t('needsReview')) : badge('fail', '✗ ' + t('notVerified'));
    const cards = (v.checks || []).map((c) => {
      const d = c.details || {};
      const body = [h('p', {}, L(c, 'reason'))];
      if (c.id === 'paypal_ready' && d.sub_checks) body.push(h('ul', { class: 'clean' }, d.sub_checks.map((s) => h('li', {}, badge(s.status), ' ', L(s, 'reason')))));
      if (c.id === 'authorized_to_practice') {
        const a = d.accreditation;
        if (a) body.push(h('dl', { class: 'kv' }, h('dt', {}, t('org')), h('dd', {}, a.organization || '—'),
          h('dt', {}, t('accExp')), h('dd', {}, (a.accreditation_expires || '—') + (a.accreditation_pending_renewal ? ' *' : '') + (a.accreditation_pending_renewal ? ' ' + t('pending') : '')),
          h('dt', {}, t('recExp')), h('dd', {}, (a.organization_recognition_expires || '—') + (a.organization_pending_renewal ? ' *' : '') + (a.organization_pending_renewal ? ' ' + t('pending') : ''))));
        if (c.route === 'attorney' || d.bar) body.push(h('p', { class: 'small' }, simTag(), ' ', t('viaSim'), ' · ', h('a', { href: v.bar_lookup_url || 'https://www.floridabar.org/directories/find-mbr/', target: '_blank', rel: 'noopener noreferrer' }, t('barLink'))));
      }
      return h('div', { class: 'check' }, h('h3', {}, L(c, 'label'), badge(c.status), c.simulated ? simTag() : null), ...body, h('p', { class: 'small muted' }, c.source));
    });
    box.replaceChildren(h('div', { class: 'row' }, h('h2', { class: 'grow' }, t('payee')), overall), h('p', {}, h('b', {}, v.display_name)),
      h('div', { class: 'grid2' }, cards),
      h('dl', { class: 'kv' }, h('dt', {}, t('snapshot')), h('dd', {}, `${t('roster')}: ${v.snapshot?.eoir_roster_report_date} · ${t('discipline')}: ${v.snapshot?.eoir_currently_disciplined_page_date}`),
        h('dt', {}, t('checkedAt')), h('dd', {}, fmtDate(v.checked_at)),
        casePayee ? [h('dt', {}, t('bound')), h('dd', {}, h('code', {}, casePayee.merchant_id_masked || '—'), ' ', casePayee.simulated ? simTag() : null, h('div', { class: 'small muted' }, t('locked')))] : null),
      h('p', { class: 'small muted' }, L(v, 'disclaimer')));
  } catch (e) { box.replaceChildren(h('h2', {}, t('payee')), errBox(e)); }
  return box;
}

// ------------------------------------------------------------------ AI check box
function aiBox(v) {
  if (!v) return h('p', { class: 'muted small' }, t('noCheck'));
  const rows = (v.checks || []).map((c) => h('li', {}, badge(c.status), ' ', h('b', {}, (CHECK_NAMES[c.id] || [c.id, c.id])[lang === 'es' ? 1 : 0]), ': ', L(c, 'reason')));
  return h('div', { 'data-testid': 'ai-check' }, h('h3', {}, t('aiCheck')), h('div', { class: 'notice n-info small' }, t('aiNever')),
    h('p', {}, `${t('score')}: ${v.score ?? '—'} · ${t('recommendation')}: `, h('b', {}, t('rec_' + v.recommendation) || v.recommendation || '—')),
    v.explanation ? h('p', { class: 'small' }, lang === 'es' ? v.explanation.summary_es : v.explanation.summary_en) : null,
    h('ul', { class: 'clean' }, rows), v.error ? h('p', { class: 'small muted' }, 'error: ' + v.error) : null);
}
async function loadProofImage(ms) {
  const tok = store.get()[current];
  const res = await fetch(`/api/milestones/${ms}/proof/image`, { headers: { authorization: 'Bearer ' + tok } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// ------------------------------------------------------------------ PayPal JS SDK (real sandbox popup)
let sdkPromise = null;
function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.paypal_client_id) throw new Error('PayPal client id is not configured');
    await new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypal_client_id)}&currency=${cfg.currency}&intent=${cfg.intent}&components=buttons&disable-funding=card,credit,paylater`;
      s.onload = ok; s.onerror = () => no(new Error('PayPal SDK failed to load')); document.head.append(s);
    });
    return window.paypal;
  })();
  sdkPromise.catch(() => { sdkPromise = null; });
  return sdkPromise;
}
async function mountPayPal(slot, ms, onDone) {
  slot.replaceChildren(h('p', { class: 'muted small' }, t('loading')));
  try {
    const paypal = await loadSdk();
    slot.replaceChildren();
    await paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay' },
      // createOrder asks OUR guard-backed endpoint to create the PayPal order (intent=AUTHORIZE); the payee checks run first (409 if not verified)
      createOrder: async () => { const r = await api('POST', `/api/milestones/${ms}/order`, { payment_source: 'paypal' }); return r.payment.order_id; },
      // onApprove asks OUR endpoint to authorize the approved order: funds are held, not collected
      onApprove: async () => { try { await api('POST', `/api/milestones/${ms}/authorize`); setFlash('ok', t('funded')); } catch (e) { setFlash('err', e.message); } onDone(); },
      onCancel: () => { slot.prepend(h('div', { class: 'notice n-warn' }, t('cancelled'))); },
      onError: (e) => { slot.prepend(h('div', { class: 'notice n-err' }, String(e?.message || e))); },
    }).render(slot);
  } catch (e) { slot.replaceChildren(errBox(e)); }
}

// ------------------------------------------------------------------ audit
async function auditBox(caseId) {
  const d = h('details', {}, h('summary', {}, t('audit')));
  d.addEventListener('toggle', async () => {
    if (!d.open || d.dataset.loaded) return; d.dataset.loaded = '1';
    try {
      const a = await api('GET', `/api/cases/${caseId}/audit`);
      d.append(h('div', { class: 'audit' }, h('table', {}, a.entries.slice(-40).map((x) => h('tr', {}, h('td', {}, fmtDate(x.at)), h('td', {}, x.actor), h('td', {}, h('code', {}, x.action)))))));
    } catch (e) { d.append(errBox(e)); }
  });
  return d;
}

// ------------------------------------------------------------------ views
const state = { caseId: null };
const stateBadge = (s) => h('span', { class: 'badge b-state' }, t('s_' + s));

async function milestoneCard(c, m, role, rerender) {
  const card = h('div', { class: 'card', 'data-testid': 'milestone', 'data-state': m.state },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, `${m.seq}. ${m.title}`), stateBadge(m.state), h('b', {}, `$${m.amount} ${c.currency}`)));
  const act = h('div', {}); card.append(act);
  const run = async (fn, okMsg) => { try { await fn(); if (okMsg) setFlash('ok', okMsg); } catch (e) { setFlash('err', e.message); if (e.data?.checks) flash.checks = e.data.checks; } rerender(); };

  let proof = null, ver = null;
  if (['proof_submitted', 'verified', 'captured', 'rejected', 'voided'].includes(m.state)) {
    try { proof = await api('GET', `/api/milestones/${m.id}/proof`); } catch { /* none */ }
    try { ver = await api('GET', `/api/milestones/${m.id}/verification`); } catch { /* none */ }
  }
  const proofView = async () => {
    const out = h('div', {});
    if (proof) {
      out.append(h('dl', { class: 'kv' }, h('dt', {}, t('sha')), h('dd', {}, h('code', {}, proof.sha256)), h('dt', {}, ''), h('dd', {}, proof.filename || '')));
      if (proof.image_available && role !== 'provider') { const u = await loadProofImage(m.id); if (u) out.append(h('img', { class: 'proof', src: u, alt: 'proof' })); }
    }
    out.append(aiBox(ver));
    return out;
  };

  if (role === 'family') {
    if (m.state === 'created') {
      const slot = h('div', { class: 'pp-slot', 'data-testid': 'paypal-slot' });
      const btn = h('button', { class: 'primary', 'data-testid': 'fund-btn', onclick: () => { btn.disabled = true; mountPayPal(slot, m.id, rerender); } }, t('fund'));
      act.append(h('p', { class: 'small muted' }, t('fundHelp'), ' ', t('popupNote')), btn, slot);
    } else if (['authorized', 'reauthorized'].includes(m.state)) act.append(h('p', {}, t('funded'), ' ', t('waitingProof')));
    else if (m.state === 'proof_submitted') act.append(h('p', {}, t('waitingReview')), await proofView());
    else if (m.state === 'verified') {
      act.append(h('p', {}, t('verifiedBy') + ': ', h('b', {}, m.verified_by || '—')), h('h3', {}, t('proofToApprove')), await proofView());
      const reason = h('input', { placeholder: t('reason'), 'aria-label': t('reason') });
      act.append(h('p', { class: 'small muted' }, t('approveHelp')),
        h('div', { class: 'row' }, h('button', { class: 'primary', 'data-testid': 'approve-btn', onclick: () => run(() => api('POST', `/api/milestones/${m.id}/approve`, { proof_sha256: proof.sha256, proof_id: proof.proof_id }), t('captured')) }, '✓ ' + t('approve')),
          reason, h('button', { class: 'danger', onclick: () => run(() => api('POST', `/api/milestones/${m.id}/reject`, { reason: reason.value || 'rejected by family' }), t('voided')) }, t('reject'))));
    } else if (m.state === 'captured') act.append(h('p', {}, badge('pass', t('captured')), ' ', t('capture') + ': ', h('code', {}, m.payment?.capture_id || '—')), await proofView());
    else act.append(h('p', {}, m.state === 'expired' ? t('expired') : t('voided')));
  }

  if (role === 'provider') {
    if (m.state === 'created') act.append(h('p', { class: 'muted' }, t('s_created')));
    else if (['authorized', 'reauthorized'].includes(m.state)) {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': t('file') });
      const note = h('input', { placeholder: t('note'), 'aria-label': t('note') });
      const send = async (bytes, name) => {
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await api('POST', `/api/milestones/${m.id}/proof`, { filename: name, note: note.value || undefined, file_base64: btoa(bin) });
      };
      act.append(h('h3', {}, t('upload')), h('label', {}, t('file')), file, h('label', {}, t('note')), note,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'primary', 'data-testid': 'upload-btn', onclick: () => run(async () => { const f = file.files[0]; if (!f) throw new Error(t('file')); await send(new Uint8Array(await f.arrayBuffer()), f.name); }, t('submitted')) }, t('submit')),
          h('button', { 'data-testid': 'sample-btn', onclick: () => run(async () => {
            // synthetic sample receipt + random trailer bytes so each upload is a new file (the proof-reuse registry is real)
            const b = new Uint8Array(await (await fetch('/samples/good_receipt_notice.png')).arrayBuffer()); const tail = crypto.getRandomValues(new Uint8Array(16));
            const all = new Uint8Array(b.length + 16); all.set(b); all.set(tail, b.length); await send(all, 'good_receipt_notice.png');
          }, t('submitted')) }, t('useSample'))));
    } else if (m.state === 'proof_submitted') act.append(h('p', {}, t('waitingReview')), aiBox(ver));
    else act.append(h('p', {}, t('s_' + m.state)));
  }

  if (role === 'reviewer') {
    if (m.state === 'proof_submitted') {
      const note = h('input', { placeholder: t('verifyNote'), 'aria-label': t('verifyNote') });
      const reason = h('input', { placeholder: t('reason'), 'aria-label': t('reason') });
      act.append(await proofView(), h('p', { class: 'small muted' }, t('verifyHelp')),
        h('div', { class: 'row' }, h('button', { class: 'primary', 'data-testid': 'verify-btn', onclick: () => run(() => api('POST', `/api/milestones/${m.id}/verify`, { note: note.value || undefined }), t('s_verified')) }, t('verifyBtn')), note),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'danger', onclick: () => run(() => api('POST', `/api/milestones/${m.id}/reject`, { reason: reason.value || 'rejected by reviewer' }), t('voided')) }, t('reject')), reason));
    } else if (['verified', 'captured'].includes(m.state)) act.append(await proofView());
    else act.append(h('p', { class: 'muted' }, t('s_' + m.state)));
  }
  return card;
}

async function caseView(id, role, rerender) {
  const c = await api('GET', `/api/cases/${id}`);
  const wrap = h('div', {});
  wrap.append(h('button', { onclick: () => { state.caseId = null; rerender(); } }, t('back')),
    h('div', { class: 'card', style: 'margin-top:10px' }, h('h2', {}, c.title), h('dl', { class: 'kv' }, h('dt', {}, t('beneficiary')), h('dd', {}, c.beneficiary_name || '—'), h('dt', {}, t('type')), h('dd', {}, c.case_type || '—'))),
    flashBox(), await payeePanel(c.provider_id, c.payee), h('h2', {}, t('milestones')));
  if (flash?.checks) { /* shown by the flash text; details are in the payee panel */ }
  for (const m of c.milestones) wrap.append(await milestoneCard(c, m, role, rerender));
  wrap.append(await auditBox(id));
  return wrap;
}

async function listView(role, rerender) {
  const wrap = h('div', {}); wrap.append(flashBox());
  const { cases } = await api('GET', '/api/cases');
  const head = h('div', { class: 'row' }, h('h2', { class: 'grow' }, t('cases')), h('button', { onclick: rerender }, t('refresh')));
  if (role === 'provider') {
    const b = h('button', { class: 'primary', 'data-testid': 'new-case', onclick: async () => {
      b.disabled = true; b.textContent = t('creating');
      try {
        const r = await api('POST', '/api/cases', { title: 'Family petition support (synthetic demo)', beneficiary_name: 'Mateo Reyes', case_type: 'Family petition I-130 (synthetic)',
          milestones: [{ title: 'Filing receipt (Form I-130)', amount: '20.00', form_type: 'I-130', document_type: 'receipt_notice' }, { title: 'Case review call', amount: '15.00' }] });
        state.caseId = r.id;
      } catch (e) { setFlash('err', e.message); }
      rerender();
    } }, '+ ' + t('newCase'));
    head.append(b);
  }
  wrap.append(head);
  if (!cases.length) wrap.append(h('p', { class: 'muted' }, t('noCases')));
  for (const c of cases) wrap.append(h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('b', {}, c.title), h('div', { class: 'small muted' }, fmtDate(c.created_at))), h('button', { 'data-testid': 'open-case', onclick: () => { state.caseId = c.id; rerender(); } }, t('open'))));
  if (role === 'provider') wrap.append(await onboardingBox());
  return wrap;
}
async function onboardingBox() {
  const out = h('div', {});
  const b = h('button', { onclick: async () => {
    try { const r = await api('POST', '/api/provider/onboarding');
      out.replaceChildren(h('div', { class: 'notice n-info' }, r.referral_mode === 'live' ? t('onbDone') : [simTag(), ' ', t('onbSim')], r.action_url ? h('div', {}, h('a', { href: r.action_url, target: '_blank', rel: 'noopener noreferrer' }, short(r.action_url, 70))) : null));
    } catch (e) { out.replaceChildren(errBox(e)); } } }, t('onboarding'));
  return h('div', { class: 'card' }, b, out);
}

function loginView(rerender) {
  const wrap = h('div', {});
  const lis = (a) => h('ul', { class: 'clean' }, a.map((x) => h('li', {}, x)));
  wrap.append(h('div', { class: 'card hero' }, h('h2', {}, t('heroTitle')), h('p', {}, t('heroP1')), h('p', { class: 'muted' }, t('featured'))),
    h('div', { class: 'grid2' }, h('div', { class: 'card' }, h('h3', {}, badge('pass', t('real'))), lis(t('realList'))),
      h('div', { class: 'card' }, h('h3', {}, simTag(), ' ', t('sim')), lis(t('simList')), h('h3', {}, badge('warn', t('planned'))), lis(t('plannedList')))));
  const tok = h('input', { type: 'password', autocomplete: 'off', 'aria-label': t('token'), 'data-testid': 'token-input' });
  const err = h('div', {});
  wrap.append(h('div', { class: 'card' }, h('h2', {}, t('signin')), h('p', { class: 'muted small' }, t('tokenHelp')), h('label', {}, t('token')), tok,
    h('p', {}, h('button', { class: 'primary', 'data-testid': 'signin', onclick: async () => { err.replaceChildren(); if (await addToken(tok.value.trim())) rerender(); else err.append(h('div', { class: 'notice n-err' }, t('badToken'))); } }, t('signinBtn'))), err));
  return wrap;
}

// ------------------------------------------------------------------ shell
async function render() {
  document.documentElement.lang = lang;
  $('#brandSub').textContent = `${t('tagline')} · ${t('featured')}`;
  $('#disclaimer').innerHTML = T[lang].disclaimer; // static, trusted strings only
  $('#langEn').className = lang === 'en' ? 'on' : ''; $('#langEs').className = lang === 'es' ? 'on' : '';
  const tokens = store.get(); const roles = ROLE_ORDER.filter((r) => tokens[r]);
  if (!roles.includes(current)) current = roles[0] || null;
  $('#roleTabs').replaceChildren(...roles.map((r) => h('button', { class: 'tab' + (r === current ? ' active' : ''), role: 'tab', 'data-testid': 'tab-' + r, onclick: () => { current = r; sessionStorage.setItem('gp_role', r); state.caseId = null; render(); } }, t('role_' + r))),
    ...(roles.length ? [h('button', { onclick: () => { sessionStorage.clear(); current = null; state.caseId = null; render(); } }, t('signout'))] : []));
  const app = $('#app');
  if (!current) { app.replaceChildren(loginView(render)); return; }
  app.replaceChildren(h('p', { class: 'muted' }, t('loading')));
  try {
    const v = state.caseId ? await caseView(state.caseId, current, render) : await listView(current, render);
    app.replaceChildren(v);
  } catch (e) {
    if (e.status === 401) { const s = store.get(); delete s[current]; store.set(s); current = null; render(); return; }
    app.replaceChildren(errBox(e), h('button', { onclick: () => { state.caseId = null; render(); } }, t('back')));
  }
}
$('#langEn').addEventListener('click', () => { lang = 'en'; localStorage.setItem('gp_lang', 'en'); render(); });
$('#langEs').addEventListener('click', () => { lang = 'es'; localStorage.setItem('gp_lang', 'es'); render(); });

// login link: https://host/#login=<token> (token is removed from the address bar immediately)
const m = location.hash.match(/login=([A-Za-z0-9_\-.]+)/);
if (m) { history.replaceState(null, '', location.pathname); await addToken(m[1]); }
const lm = new URLSearchParams(location.search).get('lang'); if (lm === 'es' || lm === 'en') lang = lm;
render();
