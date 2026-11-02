/**
 * Deterministic proof checks. The model never decides anything: it only extracts fields (see extraction.ts).
 * Everything here is pure, repeatable and explainable in English and Spanish.
 */
export type CheckStatus = 'pass' | 'fail' | 'not_run';
export type CheckId = 'receipt_format' | 'form_type_match' | 'notice_date_valid' | 'beneficiary_match' | 'document_type_match' | 'legibility' | 'proof_not_reused';
export type DocumentType = 'receipt_notice' | 'rfe_response' | 'interview_notice' | 'other';
export type Recommendation = 'recommend_approve' | 'needs_human_review' | 'recommend_reject';

export interface Extraction {
  form_type: string | null; receipt_number: string | null; notice_date: string | null; beneficiary_name: string | null;
  document_type: DocumentType | null; case_type: string | null; legibility: 'clear' | 'blurry' | 'unreadable'; confidence: number;
}
export interface CheckContext {
  caseCreatedAt: Date; now: Date; beneficiaryName: string | null; expectedFormType: string | null; expectedDocumentType: string | null;
  /** Looked up by the verifier from the proof registry. Counts are of OTHER milestones (never this one); ids are deliberately not exposed to families. */
  reuse?: { sameImage: number; sameReceipt: number; hasImage: boolean };
}
export interface CheckResult { id: CheckId; label_en: string; label_es: string; status: CheckStatus; weight: number; reason_en: string; reason_es: string }
export interface Verdict {
  checks: CheckResult[]; score: number; recommendation: Recommendation; highlighted: CheckId[];
  explanation: { summary_en: string; summary_es: string; highlighted: CheckId[]; human_approval_required: true; note_en: string; note_es: string };
}

export const WEIGHTS: Record<CheckId, number> = { receipt_format: 20, form_type_match: 20, notice_date_valid: 15, beneficiary_match: 20, document_type_match: 15, legibility: 5, proof_not_reused: 5 };
export const APPROVE_AT = 0.8;
export const REJECT_BELOW = 0.5;
export const MIN_CONFIDENCE = 0.6;
export const RECEIPT_RE = /^[A-Z]{3}\d{10}$/;

const LABELS: Record<CheckId, [string, string]> = {
  receipt_format: ['Receipt number format', 'Formato del número de recibo'],
  form_type_match: ['Form type matches the milestone', 'El tipo de formulario coincide con el hito'],
  notice_date_valid: ['Notice date is plausible', 'La fecha del aviso es plausible'],
  beneficiary_match: ['Beneficiary name matches the case', 'El nombre del beneficiario coincide con el caso'],
  document_type_match: ['Document type matches the milestone', 'El tipo de documento coincide con el hito'],
  legibility: ['Image is legible / extraction is confident', 'La imagen es legible / la extracción es confiable'],
  proof_not_reused: ['Proof has not been used before', 'La prueba no se ha usado antes'],
};
const DOC_ES: Record<string, string> = { receipt_notice: 'aviso de recibo', rfe_response: 'respuesta a solicitud de evidencia (RFE)', interview_notice: 'aviso de entrevista', other: 'otro' };
const DOC_EN: Record<string, string> = { receipt_notice: 'receipt notice', rfe_response: 'RFE response', interview_notice: 'interview notice', other: 'other' };

export const normForm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normReceipt = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const stripAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const nameTokens = (s: string): string[] => {
  const t = stripAccents(s).toLowerCase().replace(/[^a-z\s,'-]/g, ' ').replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
  return t;
};
/** every token of the case name must appear in the extracted name (extra middle names are fine; order does not matter) */
export function namesMatch(expected: string, found: string): boolean {
  const e = nameTokens(expected), f = new Set(nameTokens(found));
  return e.length > 0 && e.every(x => f.has(x));
}
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseIsoDate(s: string): Date | null {
  const m = ISO.exec(s.trim()); if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

type R = Pick<CheckResult, 'status' | 'reason_en' | 'reason_es'>;
const pass = (en: string, es: string): R => ({ status: 'pass', reason_en: en, reason_es: es });
const fail = (en: string, es: string): R => ({ status: 'fail', reason_en: en, reason_es: es });
const notRun = (en: string, es: string): R => ({ status: 'not_run', reason_en: en, reason_es: es });
const unread = (what_en: string, what_es: string) => notRun(`The ${what_en} could not be read from the proof, so this check was not run.`, `No se pudo leer ${what_es} en la prueba, por lo que esta verificación no se ejecutó.`);

export const CHECKS: Record<CheckId, (x: Extraction | null, c: CheckContext) => R> = {
  proof_not_reused(x, c) {
    if (!c.reuse) return notRun('The proof registry could not be consulted, so this check was not run.', 'No se pudo consultar el registro de pruebas; esta verificación no se ejecutó.');
    if (!c.reuse.hasImage) return notRun('No image was uploaded, so there is nothing to compare with earlier proofs.', 'No se subió ninguna imagen, así que no hay nada que comparar con pruebas anteriores.');
    if (c.reuse.sameImage > 0) return fail('This exact image was already submitted as proof on another milestone or case. A human must review it (details are not shown for privacy).', 'Esta misma imagen ya se envió como prueba en otro hito o caso. Una persona debe revisarla (los detalles no se muestran por privacidad).');
    if (c.reuse.sameReceipt > 0) return fail('This receipt number already appears on a proof for another milestone or case. A human must review it (details are not shown for privacy).', 'Este número de recibo ya aparece en una prueba de otro hito o caso. Una persona debe revisarla (los detalles no se muestran por privacidad).');
    return pass('This image and receipt number have not been used on any other milestone or case.', 'Esta imagen y este número de recibo no se han usado en ningún otro hito o caso.');
  },
  receipt_format(x) {
    if (!x) return notRun('AI extraction was unavailable, so this check was not run.', 'La extracción por IA no estuvo disponible; esta verificación no se ejecutó.');
    if (!x.receipt_number) return unread('receipt number', 'el número de recibo');
    const r = normReceipt(x.receipt_number);
    return RECEIPT_RE.test(r) ? pass(`Receipt number ${r} has 3 letters followed by 10 digits.`, `El número de recibo ${r} tiene 3 letras seguidas de 10 dígitos.`)
      : fail(`Receipt number "${x.receipt_number}" is not 3 letters followed by 10 digits.`, `El número de recibo "${x.receipt_number}" no tiene el formato de 3 letras seguidas de 10 dígitos.`);
  },
  form_type_match(x, c) {
    if (!c.expectedFormType) return notRun('This milestone has no expected form type, so this check was not run.', 'Este hito no tiene un tipo de formulario esperado; la verificación no se ejecutó.');
    if (!x) return notRun('AI extraction was unavailable, so this check was not run.', 'La extracción por IA no estuvo disponible; esta verificación no se ejecutó.');
    if (!x.form_type) return unread('form type', 'el tipo de formulario');
    return normForm(x.form_type) === normForm(c.expectedFormType)
      ? pass(`Form ${x.form_type} matches the expected form ${c.expectedFormType}.`, `El formulario ${x.form_type} coincide con el esperado ${c.expectedFormType}.`)
      : fail(`The proof shows form ${x.form_type}, but this milestone expects ${c.expectedFormType}.`, `La prueba muestra el formulario ${x.form_type}, pero este hito espera ${c.expectedFormType}.`);
  },
  notice_date_valid(x, c) {
    if (!x) return notRun('AI extraction was unavailable, so this check was not run.', 'La extracción por IA no estuvo disponible; esta verificación no se ejecutó.');
    if (!x.notice_date) return unread('notice date', 'la fecha del aviso');
    const d = parseIsoDate(x.notice_date);
    if (!d) return fail(`"${x.notice_date}" is not a valid date (expected YYYY-MM-DD).`, `"${x.notice_date}" no es una fecha válida (se esperaba AAAA-MM-DD).`);
    const created = parseIsoDate(day(c.caseCreatedAt))!, today = parseIsoDate(day(c.now))!;
    if (d > today) return fail(`The notice date ${x.notice_date} is in the future.`, `La fecha del aviso ${x.notice_date} está en el futuro.`);
    if (d < created) return fail(`The notice date ${x.notice_date} is before the case was created (${day(c.caseCreatedAt)}).`, `La fecha del aviso ${x.notice_date} es anterior a la creación del caso (${day(c.caseCreatedAt)}).`);
    return pass(`The notice date ${x.notice_date} is after the case was created and not in the future.`, `La fecha del aviso ${x.notice_date} es posterior a la creación del caso y no está en el futuro.`);
  },
  beneficiary_match(x, c) {
    if (!c.beneficiaryName) return notRun('The case has no beneficiary name on file, so this check was not run.', 'El caso no tiene un nombre de beneficiario registrado; la verificación no se ejecutó.');
    if (!x) return notRun('AI extraction was unavailable, so this check was not run.', 'La extracción por IA no estuvo disponible; esta verificación no se ejecutó.');
    if (!x.beneficiary_name) return unread('beneficiary name', 'el nombre del beneficiario');
    return namesMatch(c.beneficiaryName, x.beneficiary_name)
      ? pass(`The name "${x.beneficiary_name}" matches the case beneficiary.`, `El nombre "${x.beneficiary_name}" coincide con el beneficiario del caso.`)
      : fail(`The name "${x.beneficiary_name}" does not match the case beneficiary "${c.beneficiaryName}".`, `El nombre "${x.beneficiary_name}" no coincide con el beneficiario del caso "${c.beneficiaryName}".`);
  },
  document_type_match(x, c) {
    if (!c.expectedDocumentType) return notRun('This milestone has no expected document type, so this check was not run.', 'Este hito no tiene un tipo de documento esperado; la verificación no se ejecutó.');
    if (!x) return notRun('AI extraction was unavailable, so this check was not run.', 'La extracción por IA no estuvo disponible; esta verificación no se ejecutó.');
    if (!x.document_type) return unread('document type', 'el tipo de documento');
    const want = c.expectedDocumentType;
    return x.document_type === want
      ? pass(`The document is a ${DOC_EN[want]}, as this milestone requires.`, `El documento es un ${DOC_ES[want]}, como exige este hito.`)
      : fail(`The document looks like a ${DOC_EN[x.document_type]}, but this milestone requires a ${DOC_EN[want] ?? want}.`, `El documento parece ser ${DOC_ES[x.document_type]}, pero este hito requiere ${DOC_ES[want] ?? want}.`);
  },
  legibility(x) {
    if (!x) return notRun('AI extraction was unavailable, so legibility could not be assessed.', 'La extracción por IA no estuvo disponible; no se pudo evaluar la legibilidad.');
    if (x.legibility === 'unreadable') return fail('The image is unreadable.', 'La imagen es ilegible.');
    if (x.legibility === 'blurry' || x.confidence < MIN_CONFIDENCE)
      return notRun(`The image is blurry or the extraction confidence (${x.confidence.toFixed(2)}) is below ${MIN_CONFIDENCE}; a human should look at it.`, `La imagen está borrosa o la confianza de la extracción (${x.confidence.toFixed(2)}) es inferior a ${MIN_CONFIDENCE}; una persona debe revisarla.`);
    return pass(`The image is clear and the extraction confidence is ${x.confidence.toFixed(2)}.`, `La imagen es clara y la confianza de la extracción es ${x.confidence.toFixed(2)}.`);
  },
};

export const CHECK_ORDER: CheckId[] = ['receipt_format', 'form_type_match', 'notice_date_valid', 'beneficiary_match', 'document_type_match', 'legibility', 'proof_not_reused'];

/** Values read from an image the model itself calls blurry/unreadable or is not confident about are not trustworthy (vision models can invent
 *  plausible text for smudged images), so the content checks are NOT RUN on them; the legibility check carries the verdict and a human looks. */
export const untrustedExtraction = (x: Extraction | null): boolean => !!x && (x.legibility !== 'clear' || x.confidence < MIN_CONFIDENCE);

export function runChecks(x: Extraction | null, c: CheckContext): CheckResult[] {
  const untrusted = untrustedExtraction(x);
  return CHECK_ORDER.map(id => {
    const r = untrusted && id !== 'legibility' && id !== 'proof_not_reused'
      ? notRun('The image is not clear enough to trust the text read from it, so this check was not run.', 'La imagen no es lo bastante clara para confiar en el texto leído, por lo que esta verificación no se ejecutó.')
      : CHECKS[id](x, c);
    return { id, label_en: LABELS[id][0], label_es: LABELS[id][1], weight: WEIGHTS[id], ...r };
  });
}

/** pass = full weight, not_run = half weight (unsure), fail = 0. Integer math so thresholds are exact. */
export function scoreOf(checks: Pick<CheckResult, 'status' | 'weight'>[]): number {
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.status === 'pass' ? 2 * c.weight : c.status === 'not_run' ? c.weight : 0), 0);
  return total ? Math.round((got / (2 * total)) * 1000) / 1000 : 0;
}

export function recommend(checks: Pick<CheckResult, 'status' | 'weight'>[]): Recommendation {
  const s = scoreOf(checks);
  const anyFail = checks.some(c => c.status === 'fail'), anyNotRun = checks.some(c => c.status === 'not_run');
  // Never recommend approval while any check failed or was not run; never recommend rejection on incomplete evidence.
  if (s >= APPROVE_AT && !anyFail && !anyNotRun) return 'recommend_approve';
  if (s < REJECT_BELOW && !anyNotRun) return 'recommend_reject';
  return 'needs_human_review';
}

export function evaluate(x: Extraction | null, c: CheckContext): Verdict {
  const checks = runChecks(x, c); const score = scoreOf(checks); const recommendation = recommend(checks);
  const highlighted = checks.filter(k => k.status !== 'pass').map(k => k.id);
  const passN = checks.filter(k => k.status === 'pass').length;
  const head: Record<Recommendation, [string, string]> = {
    recommend_approve: ['The AI check recommends approval', 'La revisión por IA recomienda aprobar'],
    needs_human_review: ['The AI check could not decide and needs a human review', 'La revisión por IA no pudo decidir y requiere revisión humana'],
    recommend_reject: ['The AI check recommends rejection', 'La revisión por IA recomienda rechazar'],
  };
  const list = highlighted.map(id => LABELS[id]);
  return { checks, score, recommendation, highlighted, explanation: {
    summary_en: `${head[recommendation][0]}: ${passN} of ${checks.length} checks passed (score ${score.toFixed(2)}).${list.length ? ' To look at: ' + list.map(l => l[0]).join('; ') + '.' : ''}`,
    summary_es: `${head[recommendation][1]}: ${passN} de ${checks.length} verificaciones aprobadas (puntuación ${score.toFixed(2)}).${list.length ? ' A revisar: ' + list.map(l => l[1]).join('; ') + '.' : ''}`,
    highlighted, human_approval_required: true,
    note_en: 'The AI only reads the document; fixed rules produce this result. It is a suggestion: a human must still approve before any payment is captured.',
    note_es: 'La IA solo lee el documento; reglas fijas producen este resultado. Es una sugerencia: una persona debe aprobar antes de que se capture cualquier pago.' } };
}
