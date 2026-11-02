// There is NO global/demo clock any more. A demo clock exists only per case (cases.clock_offset_days), is set only through the
// admin-only route, is written to the audit log, and can never make an authorization "expired" unless PayPal's own status agrees.
export const DAY = 86_400_000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
