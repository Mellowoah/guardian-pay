/** Name handling for the practitioner lists. Public list names look like "Last, First Middle" (R&A roster) or "First M. Last" (discipline pages). */
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'esq']);
const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Lower-cased tokens, accents/punctuation/suffixes/single-letter initials removed, "(DHS only)" and "(SYNTHETIC)" markers ignored. */
export function nameTokens(name: string): string[] {
  const t = strip(name).toLowerCase().replace(/\((dhs only|synthetic[^)]*)\)/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '').split(/\s+/).filter(Boolean);
  return t.filter(x => x.length > 1 && !SUFFIX.has(x));
}
export type NameMatch = 'exact' | 'possible' | 'none';
/** exact: same token set. possible: one name's tokens are inside the other's (>=2 shared), or most tokens shared (Jaccard >= 0.6). */
export function matchNames(a: string, b: string): NameMatch {
  const A = new Set(nameTokens(a)), B = new Set(nameTokens(b));
  if (A.size < 2 || B.size < 2) return 'none'; // a single token is never enough to call two people the same
  const inter = [...A].filter(x => B.has(x)).length;
  if (inter === A.size && inter === B.size) return 'exact';
  if (inter < 2) return 'none';
  const subset = inter === A.size || inter === B.size;
  const jac = inter / (A.size + B.size - inter);
  return subset || jac >= 0.6 ? 'possible' : 'none';
}
export const normOrg = (s: string) => strip(s).toLowerCase().replace(/\(synthetic\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico' };
/** "Florida" or "FL" -> "florida"; unknown -> null */
export function stateName(s: string | null | undefined): string | null {
  if (!s) return null; const t = s.trim(); const up = t.toUpperCase();
  if (STATES[up]) return STATES[up].toLowerCase();
  const low = t.toLowerCase(); return Object.values(STATES).some(v => v.toLowerCase() === low) ? low : null;
}
/** does a discipline-page "place" ("Michigan", "New Jersey/New York") include this state? */
export const placeHasState = (place: string, state: string | null | undefined) => { const s = stateName(state); return !!s && place.split(/[\/,;]| and /i).some(p => stateName(p.replace(/\./g, '')) === s); };
