// Demo clock. FAKE_CLOCK_OFFSET_DAYS (env, or set via the reviewer-only admin endpoint) shifts "now"
// so the 3-day honor / day-25 warning / day-29 expiry logic can be demoed. PayPal itself still uses real time.
const DAY_MS = 86_400_000;
let offsetDays = Number(process.env.FAKE_CLOCK_OFFSET_DAYS ?? 0) || 0;

export const DAY = DAY_MS;
export const clock = {
  now(): Date { return new Date(Date.now() + offsetDays * DAY_MS); },
  getOffsetDays(): number { return offsetDays; },
  setOffsetDays(d: number) {
    if (!Number.isFinite(d) || d < -400 || d > 400) throw new Error('offset out of range');
    offsetDays = d;
  },
};
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
