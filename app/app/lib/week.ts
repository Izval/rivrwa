// week.ts — the "week strip": the stretch of calendar around one closed window, drawn as dry land (the market
// trades, 24/5 including the overnight session) and water (the NYSE closed window, when River's liquidity flows).
// It marks when River enters (+1h, prints settle) and leaves (−2h, before the overnight session reopens).

import { etToUtc, etDate, type ClosedWindow } from "../../../packages/core/src/clock.ts";
import { SIGNAL_DEFAULTS } from "../../../packages/core/src/signal.ts";

const H = 3_600_000;

export interface WeekStrip {
  from: number;
  to: number;
  /** Positions on [0, 1]. */
  windowStart: number;
  windowEnd: number;
  entry: number;
  exit: number;
  /** null when now lies outside the strip (the window is days away). */
  now: number | null;
  /** Midnight ET of each day in the strip, labelled with the ET weekday. */
  days: { x: number; label: string }[];
}

export function weekStrip(w: ClosedWindow, now: number): WeekStrip {
  const from = w.start - 30 * H, to = w.end + 10 * H;
  const x = (t: number) => (t - from) / (to - from);
  const days: WeekStrip["days"] = [];
  for (let d = etDate(from); ; d = nextDay(d)) {
    const t = etToUtc(d, 0);
    if (t > to) break;
    if (t >= from) days.push({ x: x(t), label: new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) });
  }
  return {
    from, to,
    windowStart: x(w.start), windowEnd: x(w.end),
    entry: x(w.start + SIGNAL_DEFAULTS.settleMs), exit: x(w.end - SIGNAL_DEFAULTS.exitBufferMs),
    now: now >= from && now <= to ? x(now) : null,
    days,
  };
}

const nextDay = (iso: string) => new Date(Date.parse(iso + "T12:00:00Z") + 24 * H).toISOString().slice(0, 10);
