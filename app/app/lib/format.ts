// format.ts — how numbers, times and addresses read in the UI. One place, so a figure looks the same on the landing,
// the dashboard and the history. Pure: used by server loaders and client components alike.

export const usd = (x: number, dp = 2) =>
  (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;

/** Signed percent with a minus sign that lines up with tabular figures. */
export const signedPct = (x: number, dp = 2) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(dp) + "%";

export const num = (x: number, dp = 2) => x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Share counts: enough decimals to show a change of a hundredth of a share. */
export const shares = (x: number) => num(x, x !== 0 && Math.abs(x) < 10 ? 4 : 2);

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const bscscanTx = (h: string) => `https://bscscan.com/tx/${h}`;
export const bscscanAddr = (a: string) => `https://bscscan.com/address/${a}`;

/** "2d 4h", "4h 12m", "12m 05s": the two most significant units. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** "Sat 3 Oct, 01:00 UTC". The product runs on UTC; the NYSE hours are explained in ET where they matter. */
export function when(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}

export const dayLabel = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
