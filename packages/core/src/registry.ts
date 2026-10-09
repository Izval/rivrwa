// registry.ts — the live asset registry: the pinned seed (assets.ts) plus every stock the discovery cron found and
// ran through the gate (gate.ts). Pure; the cron writes it to KV and every Worker reads it back through here.
//
// Enabling is automatic: a stock with a PancakeSwap v3 pool against USDT that passes the gate is enabled. Demotion
// is slow on purpose: an enabled stock stops *entering* only after two failed reviews in a row (open positions
// always exit), and it comes back by itself the next time it passes. Pinned assets never change state.

import { ASSETS, USDT, type StreamAsset } from "./assets.ts";
import type { GateReport } from "./gate.ts";
import type { InvestmentListItem } from "./binance.ts";

export interface RegistryAsset extends StreamAsset {
  source: "pinned" | "auto";
  gate?: GateReport | null;
  failStreak: number;
}

/** What the catalog shows for every listed token, whether or not it has a pool. */
export interface StockStatus {
  state: "running" | "reviewing" | "not_eligible";
  reason: string | null;
  at: number;
}

export interface Registry {
  at: number;
  assets: RegistryAsset[];
  /** By token address (lowercase). */
  status: Record<string, StockStatus>;
}

export const DEMOTE_AFTER = 2;

export const seedAsset = (a: StreamAsset): RegistryAsset => ({ ...a, source: a.pinned ? "pinned" : "auto", failStreak: 0 });

/** The stored registry over the seed: pinned seed assets always win (keeping their latest gate report). */
export function mergeRegistry(stored: Registry | null, seed: readonly StreamAsset[] = ASSETS): RegistryAsset[] {
  const byToken = new Map<string, RegistryAsset>();
  for (const a of stored?.assets ?? []) byToken.set(a.token, a);
  for (const s of seed) {
    const prev = byToken.get(s.token);
    if (s.pinned) byToken.set(s.token, { ...seedAsset(s), gate: prev?.gate ?? null });
    else if (!prev) byToken.set(s.token, seedAsset(s));
  }
  return [...byToken.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const resolveAsset = (list: readonly StreamAsset[], symbol: string) => list.find((a) => a.symbol.toUpperCase() === symbol.toUpperCase());

/** Applies one gate review. Pinned: always enabled. Otherwise pass → enabled; fail → disabled after DEMOTE_AFTER in a row. */
export function applyGate(base: StreamAsset, prev: RegistryAsset | undefined, report: GateReport): RegistryAsset {
  if (base.pinned) return { ...seedAsset(base), enabled: true, gate: report };
  const failStreak = report.pass ? 0 : (prev?.failStreak ?? 0) + 1;
  const enabled = report.pass || (!!prev?.enabled && failStreak < DEMOTE_AFTER);
  const note = report.pass ? undefined : `Gate: ${report.reasons.join("; ")}`;
  return { ...base, enabled, pinned: false, source: "auto", gate: report, failStreak, note };
}

/** The pool River would use for a stock token: PancakeSwap v3, paired with USDT, deepest first. */
export function pickPool(items: readonly InvestmentListItem[], symbol: string): InvestmentListItem | null {
  const up = symbol.toUpperCase();
  return items
    .filter((i) => i.defiProtocolId === "pancakeswap3")
    .filter((i) => { const pair = i.investmentName.toUpperCase().split("-"); return pair.includes(up) && pair.includes("USDT"); })
    .sort((a, b) => +b.tvl - +a.tvl)[0] ?? null;
}

/** StreamAsset from discovery data. Orientation comes from the chain (token0), never from the pair name. */
export function assetFromPool(d: {
  symbol: string; underlying: string; token: string; pool: string; investmentId: string;
  token0: string; token1: string; fee: number; tickSpacing: number;
}): StreamAsset | null {
  const t = d.token.toLowerCase(), t0 = d.token0.toLowerCase(), t1 = d.token1.toLowerCase();
  if (!((t0 === t && t1 === USDT) || (t1 === t && t0 === USDT))) return null;
  return {
    symbol: d.symbol, underlying: d.underlying, token: t, decimals: 18, pool: d.pool.toLowerCase(), investmentId: d.investmentId,
    feeTier: d.fee, tickSpacing: d.tickSpacing, stockIsToken0: t0 === t, enabled: false,
  };
}
