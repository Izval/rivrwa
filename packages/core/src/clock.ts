// clock.ts — the Wall Street clock.
//
// bStocks trade 24/7 on-chain, but the underlying shares do not. The underlying's reference
// price stops moving from the end of the post-market session (20:00 ET) on the last trading
// day until the overnight session opens (20:00 ET the evening before the next trading day).
// That gap is a "closed window": the on-chain price is anchored and lateralizes, which is
// when River puts liquidity to work.
//
// The Binance RWA Data API advertises marketStatus/nextOpenTime, but they come back null
// (see docs/dx-log.md), so the clock is computed here from the NYSE calendar.

const ET = "America/New_York";
const H = 3_600_000;

/** NYSE full-day closures (ISO dates, ET). Source: NYSE holiday calendar 2026–2027. */
export const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** Offset (ms) of America/New_York vs UTC at a given instant (handles DST). */
function etOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ms for a wall-clock time in New York on an ISO date. */
export function etToUtc(isoDate: string, hour: number, minute = 0): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // Two passes converge across DST boundaries.
  let t = guess - etOffsetMs(guess);
  t = guess - etOffsetMs(t);
  return t;
}

/** ISO date (YYYY-MM-DD) of an instant, in New York. */
export function etDate(utcMs: number): string {
  return new Date(utcMs + etOffsetMs(utcMs)).toISOString().slice(0, 10);
}

const addDays = (iso: string, n: number) =>
  new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);

export function isTradingDay(iso: string): boolean {
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(iso);
}

export interface ClosedWindow {
  /** Post-market end of the last trading day (20:00 ET), UTC ms. */
  start: number;
  /** Overnight-session open before the next trading day (20:00 ET the previous evening), UTC ms. */
  end: number;
  lastTradingDay: string;
  nextTradingDay: string;
  /** Why the market is closed: weekend, holiday, or both. */
  reason: "weekend" | "holiday" | "weekend+holiday";
  hours: number;
}

/**
 * The closed window that contains `utcMs`, or the next one if the market is open.
 * A window exists only when at least one non-trading day separates two trading days:
 * between consecutive trading days the overnight session keeps the reference moving.
 */
export function closedWindowAt(utcMs: number): ClosedWindow {
  // Scan trading days from a few days back (a window can span Thu 20:00 → Mon 20:00) and
  // return the first window that has not ended yet.
  for (let last = addDays(etDate(utcMs), -6), i = 0; i < 40; i++, last = addDays(last, 1)) {
    if (!isTradingDay(last)) continue;
    let next = addDays(last, 1);
    const gap: string[] = [];
    while (!isTradingDay(next)) { gap.push(next); next = addDays(next, 1); }
    if (gap.length === 0) continue;
    const start = etToUtc(last, 20);
    const end = etToUtc(addDays(next, -1), 20);
    if (utcMs >= end) continue;
    const weekend = gap.some((g) => [0, 6].includes(new Date(g + "T12:00:00Z").getUTCDay()));
    const holiday = gap.some((g) => NYSE_HOLIDAYS.has(g));
    return {
      start, end, lastTradingDay: last, nextTradingDay: next,
      reason: weekend && holiday ? "weekend+holiday" : holiday ? "holiday" : "weekend",
      hours: Math.round((end - start) / H),
    };
  }
  throw new Error("clock: no closed window found within 40 days");
}

export type MarketPhase = "closed_window" | "open";

export interface ClockState {
  now: number;
  phase: MarketPhase;
  window: ClosedWindow;
  /** ms until the window starts (open phase) or ends (closed phase). */
  msToBoundary: number;
}

export function clockState(utcMs: number = Date.now()): ClockState {
  const w = closedWindowAt(utcMs);
  const inside = utcMs >= w.start && utcMs < w.end;
  return { now: utcMs, phase: inside ? "closed_window" : "open", window: w, msToBoundary: (inside ? w.end : w.start) - utcMs };
}

/** All closed windows whose start lies in [fromMs, toMs). Used by backtests and the UI calendar. */
export function closedWindowsBetween(fromMs: number, toMs: number): ClosedWindow[] {
  const out: ClosedWindow[] = [];
  let t = fromMs;
  while (t < toMs) {
    const w = closedWindowAt(t);
    if (w.start >= toMs) break;
    if (w.start >= fromMs) out.push(w);
    t = w.end + H;
  }
  return out;
}
