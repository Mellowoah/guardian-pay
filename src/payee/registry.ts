import { readFileSync } from 'node:fs';
import { matchNames, normOrg, placeHasState, stateName } from './names.js';

export type PracticeStatus = 'pass' | 'fail' | 'needs_review';
export interface PractitionerProfile { type: 'recognized_org_rep' | 'attorney' | 'none'; person_name: string | null; org_name: string | null; practice_state: string | null; bar_number: string | null }
export interface RepRecord { name: string; acc_exp: string; acc_pending: boolean; rep_status: string; org: string; org_recognized: string; org_exp: string; org_pending: boolean; org_status: string; dhs_only: boolean }
export interface DisciplineRecord { name: string; place: string; immediate_suspension: string; final_discipline: string; effective: string; reinstated: string }
export interface Snapshot {
  manifest: { taken: string; source: string; roster_report_date: string; currently_disciplined: { url: string; page_date: string }; previously_disciplined: { url: string; page_date: string }; counts: Record<string, number>; disclaimer: string };
  representatives: RepRecord[]; disciplined_current: DisciplineRecord[]; disciplined_previous: DisciplineRecord[];
}
export interface BarMember { state: string; bar_number: string; name: string; status: 'eligible' | 'suspended' | 'inactive' }
export interface BarLookup { simulated: true; lookup_url: string; find(state: string | null, barNumber: string | null, name: string | null): BarMember | null }

export const FLORIDA_BAR_LOOKUP = 'https://www.floridabar.org/directories/find-mbr/';
export interface PracticeCheck {
  status: PracticeStatus; simulated: boolean; route: 'eoir_recognized_org' | 'attorney_bar_simulated' | 'none';
  reason_en: string; reason_es: string;
  details: {
    accreditation?: { rep_name: string; organization: string; accreditation_expires: string; accreditation_pending_renewal: boolean; dhs_only: boolean; rep_status: string; organization_recognition_expires: string; organization_pending_renewal: boolean; organization_status: string; synthetic?: boolean };
    bar?: { state: string | null; bar_number: string | null; status: string | null; simulated: true; lookup_url: string };
    discipline: { current: 'none' | 'confirmed' | 'possible'; previous: 'none' | 'confirmed' | 'possible'; note_en?: string; note_es?: string };
    snapshot: { eoir_roster_report_date: string; eoir_currently_disciplined_page_date: string; eoir_previously_disciplined_page_date: string; snapshot_taken: string; source: string };
    manual_check_url?: string;
  };
}

export class SimulatedBar implements BarLookup {
  simulated = true as const; lookup_url: string; private members: BarMember[];
  constructor(file = new URL('../../data/bar/simulated_bar.json', import.meta.url)) { const j = JSON.parse(readFileSync(file, 'utf8')); this.members = j.members; this.lookup_url = j.lookup_url; }
  find(state: string | null, barNumber: string | null, name: string | null): BarMember | null {
    if (!barNumber) return null;
    return this.members.find(m => m.bar_number.toLowerCase() === barNumber.toLowerCase() && (!state || stateName(m.state) === stateName(state)) && (!name || matchNames(m.name, name) === 'exact')) ?? null;
  }
}

/** only an unambiguous "Yes..." counts as reinstated; blank, "No..." or mixed values ("Yes ... No") stay disciplined (conservative) */
export const isReinstated = (v: string) => /^\s*yes/i.test(v) && !/no\b/i.test(v);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const D = (s: string) => `${s}`;

export class PractitionerRegistry {
  constructor(public snapshot: Snapshot, private bar: BarLookup, private overlay?: { representatives: RepRecord[]; disciplined_current: DisciplineRecord[] }) {}

  static load(opts: { snapshotFile?: URL; overlayFile?: URL | null; bar?: BarLookup } = {}): PractitionerRegistry {
    const snap = JSON.parse(readFileSync(opts.snapshotFile ?? new URL('../../data/eoir/snapshot.json', import.meta.url), 'utf8')) as Snapshot;
    let overlay; if (opts.overlayFile !== null) { try { overlay = JSON.parse(readFileSync(opts.overlayFile ?? new URL('../../data/eoir/demo_overlay.json', import.meta.url), 'utf8')); } catch { /* optional */ } }
    return new PractitionerRegistry(snap, opts.bar ?? new SimulatedBar(), overlay);
  }

  private snapInfo() { const m = this.snapshot.manifest; return { eoir_roster_report_date: m.roster_report_date, eoir_currently_disciplined_page_date: m.currently_disciplined.page_date, eoir_previously_disciplined_page_date: m.previously_disciplined.page_date, snapshot_taken: m.taken, source: m.source }; }

  private discipline(name: string | null, state: string | null) {
    const out = { current: 'none' as 'none' | 'confirmed' | 'possible', previous: 'none' as 'none' | 'confirmed' | 'possible', hit: null as DisciplineRecord | null, hitReinstated: false };
    if (!name) return out;
    const cur = [...this.snapshot.disciplined_current, ...(this.overlay?.disciplined_current ?? [])];
    for (const r of cur) {
      const m = matchNames(r.name, name); if (m === 'none') continue;
      const reinstated = isReinstated(r.reinstated);
      const confirmed = m === 'exact' && placeHasState(r.place, state);
      if (reinstated) { if (out.current === 'none') { out.previous = confirmed ? 'confirmed' : 'possible'; } continue; } // reinstated: informational
      if (confirmed) { out.current = 'confirmed'; out.hit = r; return out; }
      if (out.current !== 'confirmed') { out.current = 'possible'; out.hit = out.hit ?? r; }
    }
    for (const r of this.snapshot.disciplined_previous) {
      const m = matchNames(r.name, name); if (m === 'none') continue;
      if (m === 'exact' && placeHasState(r.place, state)) out.previous = 'confirmed'; else if (out.previous === 'none') out.previous = 'possible';
    }
    return out;
  }

  /** The second payee check: is this person authorized to practice immigration law (EOIR recognized-org accredited rep, or a licensed attorney) and not currently disciplined by EOIR? */
  check(p: PractitionerProfile, today = new Date()): PracticeCheck {
    const snapshot = this.snapInfo(); const t = iso(today);
    const base = { discipline: { current: 'none' as const, previous: 'none' as const }, snapshot };
    const fail = (en: string, es: string, extra: Partial<PracticeCheck['details']> = {}, route: PracticeCheck['route'] = 'none'): PracticeCheck => ({ status: 'fail', simulated: route === 'attorney_bar_simulated', route, reason_en: en, reason_es: es, details: { ...base, ...extra } });
    if (p.type === 'none' || !p.person_name) return fail('No immigration-practice credentials on file for this provider (not an EOIR-recognized organization representative and no bar license on file).', 'No hay credenciales para ejercer derecho migratorio registradas para este proveedor (no es representante de una organización reconocida por EOIR ni tiene licencia de abogado registrada).', { manual_check_url: FLORIDA_BAR_LOOKUP });

    // 1) discipline cross-check (hard fail only on a CONFIRMED match: same name AND same state)
    const disc = this.discipline(p.person_name, p.practice_state);
    const discDetails = { current: disc.current, previous: disc.previous } as PracticeCheck['details']['discipline'];
    if (disc.current === 'confirmed') {
      const h = disc.hit!;
      return { status: 'fail', simulated: false, route: p.type === 'attorney' ? 'attorney_bar_simulated' : 'eoir_recognized_org', reason_en: `HARD FAIL: this person matches the EOIR list of currently disciplined practitioners (${h.final_discipline}, effective ${h.effective.replace(/\s*\(PDF\)/, '')}, ${h.place}).`, reason_es: `FALLA DEFINITIVA: esta persona coincide con la lista de profesionales actualmente sancionados por EOIR (${h.final_discipline}, vigente desde ${h.effective.replace(/\s*\(PDF\)/, '')}, ${h.place}).`, details: { discipline: discDetails, snapshot, manual_check_url: FLORIDA_BAR_LOOKUP } };
    }
    const possibleNote = disc.current === 'possible' ? { note_en: 'A similar name appears on the EOIR currently-disciplined list; it could be a different person (state differs or is unknown). A human must review.', note_es: 'Un nombre similar aparece en la lista de EOIR de profesionales actualmente sancionados; podría ser otra persona (el estado difiere o se desconoce). Una persona debe revisarlo.' } : {};
    if (disc.previous !== 'none') Object.assign(discDetails, { note_en: 'Name appears on the EOIR list of previously disciplined (reinstated or resolved) practitioners; informational only.', note_es: 'El nombre aparece en la lista de EOIR de profesionales sancionados anteriormente (reinstalados o resueltos); solo informativo.' });
    Object.assign(discDetails, possibleNote);

    // 2a) accredited representative of a recognized organization
    if (p.type === 'recognized_org_rep') {
      const all = [...this.snapshot.representatives, ...(this.overlay?.representatives ?? [])];
      const named = all.filter(r => matchNames(r.name, p.person_name!) === 'exact');
      const theOrg = p.org_name ? normOrg(p.org_name) : null;
      const rec = named.find(r => theOrg && normOrg(r.org) === theOrg);
      if (!rec) {
        const similar = all.some(r => matchNames(r.name, p.person_name!) === 'possible' && (!theOrg || normOrg(r.org) === theOrg));
        if (similar || (named.length && !theOrg)) return { status: 'needs_review', simulated: false, route: 'eoir_recognized_org', reason_en: 'A similar name is on the EOIR roster but not an exact match for this organization. A human must review (name spelling or organization may differ).', reason_es: 'Un nombre similar está en el registro de EOIR pero no coincide exactamente con esta organización. Una persona debe revisarlo (la ortografía o la organización pueden diferir).', details: { discipline: discDetails, snapshot } };
        return fail(named.length ? 'This person is on the EOIR roster, but not as a representative of the organization they claim. Accredited representatives may practice only through their recognized organization.' : 'Not found on the EOIR roster of accredited representatives (snapshot).', named.length ? 'Esta persona está en el registro de EOIR, pero no como representante de la organización que indica. Los representantes acreditados solo pueden ejercer a través de su organización reconocida.' : 'No aparece en el registro de EOIR de representantes acreditados (instantánea).', { discipline: discDetails }, 'eoir_recognized_org');
      }
      const accDet = { rep_name: rec.name, organization: rec.org, accreditation_expires: rec.acc_exp, accreditation_pending_renewal: rec.acc_pending, dhs_only: rec.dhs_only, rep_status: rec.rep_status, organization_recognition_expires: rec.org_exp, organization_pending_renewal: rec.org_pending, organization_status: rec.org_status, ...((rec.org + rec.name).includes('SYNTHETIC') || rec.org.includes('SYNTHETIC') ? { synthetic: true } : {}) };
      const details = { accreditation: accDet, discipline: discDetails, snapshot };
      if (rec.rep_status !== 'Active' || rec.org_status !== 'Active') return { status: 'fail', simulated: false, route: 'eoir_recognized_org', reason_en: `EOIR roster status is not Active (representative: ${rec.rep_status}, organization: ${rec.org_status}).`, reason_es: `El estado en el registro de EOIR no es Activo (representante: ${rec.rep_status}, organización: ${rec.org_status}).`, details };
      const accExpired = rec.acc_exp < t && !rec.acc_pending, orgExpired = rec.org_exp < t && !rec.org_pending;
      if (accExpired || orgExpired) return { status: 'fail', simulated: false, route: 'eoir_recognized_org', reason_en: `${accExpired ? `Accreditation expired ${rec.acc_exp}` : `Organization recognition expired ${rec.org_exp}`} (not marked pending renewal).`, reason_es: `${accExpired ? `La acreditación venció el ${rec.acc_exp}` : `El reconocimiento de la organización venció el ${rec.org_exp}`} (sin renovación pendiente).`, details };
      const pend = rec.acc_pending || rec.org_pending;
      const status: PracticeStatus = disc.current === 'possible' ? 'needs_review' : 'pass';
      return { status, simulated: false, route: 'eoir_recognized_org', reason_en: `${status === 'pass' ? 'Listed' : 'Listed (but see the name warning)'} as an Active accredited representative of ${rec.org}; accreditation expires ${D(rec.acc_exp)}${rec.acc_pending ? ' (*pending renewal)' : ''}; organization recognition expires ${rec.org_exp}${rec.org_pending ? ' (*pending renewal)' : ''}.${rec.dhs_only ? ' DHS-only accreditation: may represent before USCIS/DHS, not before immigration courts.' : ''}${pend ? ' Renewal pending means EOIR has not yet processed the renewal.' : ''}`,
        reason_es: `${status === 'pass' ? 'Aparece' : 'Aparece (pero vea la advertencia de nombre)'} como representante acreditado Activo de ${rec.org}; la acreditación vence el ${rec.acc_exp}${rec.acc_pending ? ' (*renovación pendiente)' : ''}; el reconocimiento de la organización vence el ${rec.org_exp}${rec.org_pending ? ' (*renovación pendiente)' : ''}.${rec.dhs_only ? ' Acreditación solo para DHS: puede representar ante USCIS/DHS, no ante tribunales de inmigración.' : ''}${pend ? ' Renovación pendiente significa que EOIR aún no ha procesado la renovación.' : ''}`, details };
    }

    // 2b) licensed attorney: SIMULATED bar lookup (no live bar data), with a link for the real manual check
    const m = this.bar.find(p.practice_state, p.bar_number, p.person_name);
    const barDet = { state: p.practice_state, bar_number: p.bar_number, status: m?.status ?? null, simulated: true as const, lookup_url: this.bar.lookup_url };
    const details = { bar: barDet, discipline: discDetails, snapshot, manual_check_url: this.bar.lookup_url };
    const sim = 'SIMULATED bar lookup (fixture data; no live bar records were fetched). Verify on the official lookup: ';
    if (!m) return { status: 'fail', simulated: true, route: 'attorney_bar_simulated', reason_en: sim + this.bar.lookup_url + '. No matching member in the simulated records.', reason_es: 'Búsqueda de colegio de abogados SIMULADA (datos de prueba; no se consultaron registros reales). Verifique en el sitio oficial: ' + this.bar.lookup_url + '. No hay un miembro coincidente en los registros simulados.', details };
    if (m.status !== 'eligible') return { status: 'fail', simulated: true, route: 'attorney_bar_simulated', reason_en: `${sim}${this.bar.lookup_url}. Simulated record shows status "${m.status}".`, reason_es: `Búsqueda de colegio de abogados SIMULADA. Verifique en: ${this.bar.lookup_url}. El registro simulado muestra el estado "${m.status}".`, details };
    const st: PracticeStatus = disc.current === 'possible' ? 'needs_review' : 'pass';
    return { status: st, simulated: true, route: 'attorney_bar_simulated', reason_en: `${sim}${this.bar.lookup_url}. Simulated record: eligible attorney.${st === 'needs_review' ? ' See the name warning on the EOIR discipline list.' : ''}`, reason_es: `Búsqueda de colegio de abogados SIMULADA (datos de prueba). Verifique en: ${this.bar.lookup_url}. Registro simulado: abogado habilitado.${st === 'needs_review' ? ' Vea la advertencia de nombre en la lista de sanciones de EOIR.' : ''}`, details };
  }
}
