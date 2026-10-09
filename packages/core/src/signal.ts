// signal.ts — the River signal: for one asset, *when* (closed window) and *where* (band).
//
// Where = IVL's canonical band, μ ± 2σ, measured on the previous closed windows only. Each
// past window is rebased to its own entry price first, so the band measures how price moves
// *within* a closed window, not the drift between weekends. Research: research/ivl-study.
// This band beat the excursion-based band in all 6 cost scenarios, and in all 16 σ-multiple ×
// lookback variants; 2σ is IVL's untuned default.
//
// IVL's crypto-calibrated raw thresholds (withdraw < 0.10, concentrate ≥ 0.18) do not transfer
// to thin stock-token pools: single-swap wicks inflate the range W, so raw = σ²/W² sits at
// 0.01–0.05 in every window and would flag "breakout" always. So River uses IVL's σ (the
// dispersion core) and reports the score, but takes no action from the raw classification.

import { computeIVL } from "./ivl.ts";
import { closedWindowsBetween, clockState, type ClockState, type ClosedWindow } from "./clock.ts";
import { aggregate, type Candle } from "./geckoterminal.ts";

export const SIGNAL_DEFAULTS = {
  settleMs: 60 * 60_000, // enter 1h after the window opens (post-market prints settle)
  exitBufferMs: 2 * 60 * 60_000, // leave 2h before the overnight session reopens
  lookbackWindows: 4,
  sigmaMultiple: 2, // IVL canonical μ ± 2σ
  minHalfWidth: 0.005,
  // Fallback when IVL has too little closed-window history: excursion rule from Gate 0.
  quantile: 0.8,
  buffer: 1.2,
  fallbackHalfWidth: 0.03,
};

export interface Signal {
  asOf: number;
  price: number;
  clock: ClockState;
  entryAt: number;
  exitAt: number;
  band: { low: number; high: number; halfWidth: number; basis: "ivl_2sigma" | "excursion" | "fallback" };
  ivl: { score: number | null; classification: string | null; sigmaPct: number | null; windows: number };
  history: { window: string; maxExcursion: number }[];
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};

const windowCandles = (h1: Candle[], w: ClosedWindow, cfg = SIGNAL_DEFAULTS) => {
  const a = (w.start + cfg.settleMs) / 1000, b = (w.end - cfg.exitBufferMs) / 1000;
  return h1.filter((c) => c.ts >= a && c.ts <= b);
};

const rebase = (cs: Candle[]): Candle[] => {
  const p0 = cs[0].o;
  return cs.map((c) => ({ ...c, o: c.o / p0, h: c.h / p0, l: c.l / p0, c: c.c / p0 }));
};

const maxExcursion = (cs: Candle[]) => {
  const p0 = cs[0].o;
  return Math.max(...cs.map((c) => Math.max(Math.abs(c.h / p0 - 1), Math.abs(c.l / p0 - 1))));
};

/** `h1` = gap-filled hourly candles covering at least the last ~5 weeks, oldest first. */
export function computeSignal(h1: Candle[], now: number = Date.now(), cfg = SIGNAL_DEFAULTS): Signal {
  if (h1.length === 0) throw new Error("computeSignal: no candles");
  const clock = clockState(now);
  const price = h1[h1.length - 1].c;
  const past = closedWindowsBetween(h1[0].ts * 1000, Math.min(now, clock.window.start))
    .filter((w) => w.end <= now)
    .slice(-cfg.lookbackWindows)
    .map((w) => ({ w, cs: windowCandles(h1, w, cfg) }))
    .filter((x) => x.cs.length >= 6);
  const history = past.map((x) => ({ window: new Date(x.w.start).toISOString().slice(0, 10), maxExcursion: maxExcursion(x.cs) }));

  let halfWidth = cfg.fallbackHalfWidth;
  let basis: Signal["band"]["basis"] = "fallback";
  if (history.length >= 2) {
    halfWidth = Math.max(cfg.minHalfWidth, quantile(history.map((x) => x.maxExcursion), cfg.quantile) * cfg.buffer);
    basis = "excursion";
  }

  // IVL on the rebased closed windows (real trades only; filled candles dropped from 1h).
  const rebased = past.flatMap((x) => rebase(x.cs));
  const real = rebased.filter((c) => !c.filled);
  let ivl: Signal["ivl"] = { score: null, classification: null, sigmaPct: null, windows: past.length };
  if (past.length >= 2 && real.length >= 24) {
    const r = computeIVL({ "1h": real, "4h": aggregate(rebased, 4) }, { primaryScale: "1h", gamma: 0.0025 });
    if (r.ok) {
      const sigmaRel = r.lpRange.sigma / r.lpRange.vwap;
      ivl = { score: r.ivlScore, classification: r.classification, sigmaPct: sigmaRel * 100, windows: past.length };
      halfWidth = Math.max(cfg.minHalfWidth, cfg.sigmaMultiple * sigmaRel);
      basis = "ivl_2sigma";
    }
  }

  return {
    asOf: now,
    price,
    clock,
    entryAt: clock.window.start + cfg.settleMs,
    exitAt: clock.window.end - cfg.exitBufferMs,
    band: { low: price * (1 - halfWidth), high: price * (1 + halfWidth), halfWidth, basis },
    ivl,
    history,
  };
}
