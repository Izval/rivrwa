// gate.ts — Gate 0 as code: replay the production signal and planner over a pool's past closed windows and
// decide whether River may run it. This is research/gate0/sim-core.ts moved into core, so the discovery cron
// (workers/api) enables stocks with the exact replay that produced the published numbers.
//
// Model, per window: enter at window start + settle with a 50/50 budget of S, earn the pool fee on each hourly
// candle whose close is inside the range, pro rata to our liquidity against the other LPs' liquidity at that tick
// (a snapshot, scaled ×1/×2/×4 to stress competition), exit 2h before the reopen. Net = fees − IL − gas −
// River's fee − the cost of restoring the share count. The weekday control replays Tue→Thu the same way; it is
// reported for context only. The stocks are large companies whose own return is the base, so any positive net
// River adds on weekends counts, whether or not weekdays would pay more.

import { closedWindowsBetween } from "./clock.ts";
import { computeSignal, SIGNAL_DEFAULTS, type Signal } from "./signal.ts";
import { planCycle, riverFee, type Mandate } from "./planner.ts";
import { amountsAt } from "./v3.ts";
import type { Candle } from "./geckoterminal.ts";
import type { StreamAsset } from "./assets.ts";

const H = 3600;
export const GATE_COSTS = { gasUsd: 0.6, restore: 0.0035 };

/** The original Gate 0 thresholds (research/gate0/README.md, chosen 2026-09-29 for automatic enabling). */
export const GATE_RULES = {
  minIvlWindows: 4,
  minAprBase: 3,
  minWinRate: 75,
  minAprX4: 0,
  minTvlUsd: 50_000,
  /** Above this the review carries a warning (thin or unusual volume); it does not block. */
  warnAprBase: 200,
};

/** Pool snapshot: active liquidity at `tick` and liquidityNet of each initialized tick nearby (research/gate0/pool.mjs). */
export interface PoolSnapshot {
  tick: number;
  liquidity: string;
  net: Record<string, string>;
}

/** Other LPs' liquidity at any tick, walked from the snapshot, times `mult`. */
export function liquidityProfile(p: PoolSnapshot, mult: number): (tick: number) => number {
  const net = Object.entries(p.net).map(([t, n]) => [+t, BigInt(n)] as const).sort((a, b) => a[0] - b[0]);
  const L0 = BigInt(p.liquidity);
  return (tick) => {
    let L = L0;
    if (tick >= p.tick) { for (const [t, n] of net) if (t > p.tick && t <= tick) L += n; }
    else { for (let i = net.length - 1; i >= 0; i--) { const [t, n] = net[i]; if (t <= p.tick && t > tick) L -= n; } }
    return Number(L < 0n ? 0n : L) * mult;
  };
}

export interface WindowResult {
  window: string;
  halfWidthPct?: number;
  basis?: Signal["band"]["basis"];
  netPct?: number;
  /** USD breakdown for the deposit: LP fees earned, IL vs holding, gas + River's fee + restore, and the net. */
  feesUsd?: number;
  ilUsd?: number;
  costsUsd?: number;
  netUsd?: number;
  depositUsd?: number;
  skipped?: string;
}

const MANDATE: Mandate = { owner: "0x0", asset: "", allocation: 1, maxHalfWidth: 0.08, exitOnDrift: 1, skipEvents: false, restoreShares: true, expiresAt: Infinity };

/** Weekday control windows (sim2): Tuesday 01:00 UTC → Thursday 22:00 UTC, in seconds. */
export function weekdayWindows(h1: Candle[]): [number, number][] {
  const out: [number, number][] = [];
  for (let t = Math.ceil(h1[0].ts / 86400) * 86400 + 7 * 86400; t <= h1[h1.length - 1].ts; t += 86400) {
    if (new Date(t * 1000).getUTCDay() === 2) out.push([t + H, t + 2 * 86400 - 2 * H]);
  }
  return out;
}

/** Replays closed windows (default) or the weekday control. Candles must be gap-filled hourly. */
export function replay(asset: StreamAsset, h1: Candle[], snapshot: PoolSnapshot, opts: { sizeUsd?: number; mult?: number; weekday?: boolean } = {}): WindowResult[] {
  const S = opts.sizeUsd ?? 10_000;
  const Lo = liquidityProfile(snapshot, opts.mult ?? 1);
  const byTs = new Map(h1.map((c) => [c.ts, c]));
  const cfg = SIGNAL_DEFAULTS;
  const a = { ...asset, enabled: true };
  const spans: [number, number][] = opts.weekday
    ? weekdayWindows(h1).map(([x, y]) => [x * 1000, y * 1000])
    : closedWindowsBetween(h1[0].ts * 1000 + 7 * 86400e3, h1[h1.length - 1].ts * 1000).map((w) => [w.start + cfg.settleMs, w.end - cfg.exitBufferMs]);
  const rows: WindowResult[] = [];
  for (const [entry, exit] of spans) {
    const window = new Date(entry).toISOString().slice(0, 10);
    if (!byTs.has(entry / 1000) || !byTs.has(exit / 1000)) continue;
    let sig = computeSignal(h1.filter((c) => c.ts * 1000 <= entry), entry, cfg);
    // The weekday control has no closed window: present the same band as if the market were closed.
    if (opts.weekday) sig = { ...sig, clock: { ...sig.clock, phase: "closed_window" }, entryAt: entry, exitAt: exit };
    const s0 = sig.price;
    const act = planCycle({ now: entry, asset: a, signal: sig, mandate: MANDATE, inventory: { stock: S / 2 / s0, usd: S / 2 }, position: null });
    if (act.kind !== "enter") { rows.push({ window, skipped: act.kind }); continue; }
    const { priceLow: lo, priceHigh: hi } = act.range;
    const unit = amountsAt(1, s0, lo, hi);
    const Lus = (act.deposit.stock * s0 + act.deposit.usd) / (unit.stock * s0 + unit.usd);
    let fees = 0;
    for (let t = entry / 1000 + H; t <= exit / 1000; t += H) {
      const k = byTs.get(t)!;
      if (k.c < lo || k.c > hi) continue;
      const tick = Math.floor(Math.log(asset.stockIsToken0 ? k.c : 1 / k.c) / Math.log(1.0001));
      fees += k.vol * asset.feeTier * (Lus * 1e18) / (Lus * 1e18 + Lo(tick));
    }
    const s1 = byTs.get(exit / 1000)!.c, x0 = act.deposit, x1 = amountsAt(Lus, s1, lo, hi);
    const il = x0.stock * s1 + x0.usd - (x1.stock * s1 + x1.usd);
    const restore = Math.abs(x1.stock - x0.stock) * s1 * GATE_COSTS.restore;
    const dep = x0.stock * s0 + x0.usd;
    const costs = GATE_COSTS.gasUsd + riverFee(fees) + restore;
    const net = fees - il - costs;
    rows.push({
      window, halfWidthPct: +(sig.band.halfWidth * 100).toFixed(2), basis: sig.band.basis, netPct: (net / dep) * 100,
      feesUsd: fees, ilUsd: il, costsUsd: costs, netUsd: net, depositUsd: dep,
    });
  }
  return rows;
}

export interface ReplayStats { windows: number; apr: number; winRate: number; worst: number }

export function stats(rows: WindowResult[]): ReplayStats {
  const done = rows.filter((r) => r.netPct !== undefined).map((r) => r.netPct!);
  if (done.length === 0) return { windows: 0, apr: 0, winRate: 0, worst: 0 };
  return {
    windows: done.length,
    apr: (done.reduce((s, x) => s + x, 0) / done.length) * 52,
    winRate: (done.filter((x) => x > 0).length / done.length) * 100,
    worst: Math.min(...done),
  };
}

export interface GateReport {
  at: number;
  pass: boolean;
  reasons: string[];
  /** Worth a look, never blocking (e.g. an APR high enough to suggest unusual volume). */
  warnings: string[];
  ivlWindows: number;
  base: ReplayStats;
  x4: ReplayStats;
  weekday: ReplayStats;
  tvlUsd: number | null;
}

export interface GateInput {
  asset: StreamAsset;
  h1: Candle[];
  snapshot: PoolSnapshot;
  tvlUsd: number | null;
  /** Both pool tokens must have 18 decimals: the v3 math and balance reads assume it. */
  decimalsOk: boolean;
  now?: number;
}

/** Runs the replays and applies GATE_RULES. `reasons` lists every failed rule in plain words. */
export function gateReport(i: GateInput, rules = GATE_RULES): GateReport {
  const baseRows = replay(i.asset, i.h1, i.snapshot);
  const base = stats(baseRows);
  const x4 = stats(replay(i.asset, i.h1, i.snapshot, { mult: 4 }));
  const weekday = stats(replay(i.asset, i.h1, i.snapshot, { weekday: true }));
  const ivlWindows = baseRows.filter((r) => r.basis === "ivl_2sigma").length;
  const reasons: string[] = [];
  if (!i.decimalsOk) reasons.push("a pool token does not use 18 decimals");
  if (ivlWindows < rules.minIvlWindows) reasons.push(`only ${ivlWindows} closed windows with an IVL band (needs ${rules.minIvlWindows})`);
  if (base.apr < rules.minAprBase) reasons.push(`net APR ${base.apr.toFixed(1)}% is below ${rules.minAprBase}%`);
  if (base.winRate < rules.minWinRate) reasons.push(`${base.winRate.toFixed(0)}% of windows gained (needs ${rules.minWinRate}%)`);
  if (!(x4.apr > rules.minAprX4)) reasons.push(`loses money if other LPs quadruple (${x4.apr.toFixed(1)}%)`);
  if (i.tvlUsd !== null && i.tvlUsd < rules.minTvlUsd) reasons.push(`pool TVL $${Math.round(i.tvlUsd).toLocaleString("en-US")} is below $${rules.minTvlUsd.toLocaleString("en-US")}`);
  const warnings = base.apr > rules.warnAprBase ? [`net APR ${base.apr.toFixed(0)}% is unusually high; check the pool's volume`] : [];
  return { at: i.now ?? Date.now(), pass: reasons.length === 0, reasons, warnings, ivlWindows, base, x4, weekday, tvlUsd: i.tvlUsd };
}

export interface Simulation {
  sizeUsd: number;
  /** Net APR River adds on top of holding, with today's other-LP liquidity and with 2× / 4× of it. */
  scenarios: { x1: ReplayStats; x2: ReplayStats; x4: ReplayStats };
  /** Mean net USD per closed window, per scenario. */
  perWindowUsd: { x1: number; x2: number; x4: number };
  /** Every replayed window at the chosen competition level, oldest first. */
  windows: WindowResult[];
}

/** The landing's simulator: the same replay as the gate, at the user's size, for the three competition levels. */
export function simulate(asset: StreamAsset, h1: Candle[], snapshot: PoolSnapshot, sizeUsd: number, show: 1 | 2 | 4 = 1): Simulation {
  const run = (mult: number) => replay(asset, h1, snapshot, { sizeUsd, mult });
  const rows = { x1: run(1), x2: run(2), x4: run(4) };
  const meanUsd = (r: WindowResult[]) => { const d = r.filter((x) => x.netUsd !== undefined); return d.length ? d.reduce((s, x) => s + x.netUsd!, 0) / d.length : 0; };
  return {
    sizeUsd,
    scenarios: { x1: stats(rows.x1), x2: stats(rows.x2), x4: stats(rows.x4) },
    perWindowUsd: { x1: meanUsd(rows.x1), x2: meanUsd(rows.x2), x4: meanUsd(rows.x4) },
    windows: rows[`x${show}` as const].filter((r) => r.netUsd !== undefined),
  };
}
