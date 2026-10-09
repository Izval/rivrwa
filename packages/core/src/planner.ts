// planner.ts — the cycle state machine. Pure: given the clock, the signal, the user's mandate
// and the current position, decide the next action. Executors (Agentic Wallet or Altana)
// only ever carry out what this returns, so the mandate the user signed is the whole policy.

import type { Signal } from "./signal.ts";
import { fitBandToInventory, liquidityForInventory, amountsAt, snapRange, type Amounts, type TickRange } from "./v3.ts";
import type { StreamAsset } from "./assets.ts";

/** What the user agreed to, set in the River UI (or via API/MCP). */
export interface Mandate {
  owner: string;
  asset: string;
  /** Fraction (0..1] of the wallet's stock + USDT that may flow. */
  allocation: number;
  /** Never deploy a band wider than this half-width (e.g. 0.05 = ±5%). */
  maxHalfWidth: number;
  /** Leave early if price drifts this far from entry (e.g. 0.03). */
  exitOnDrift: number;
  /** Skip windows that contain a corporate action / earnings event. */
  skipEvents: boolean;
  /** After exit, buy/sell back to the original share count (limit order, weekday). */
  restoreShares: boolean;
  /** Mandate validity (UTC ms). The signer's own expiry must not exceed it. */
  expiresAt: number;
}

export interface OpenPosition {
  nftId: string;
  openedAt: number;
  entryPrice: number;
  range: TickRange;
  entryAmounts: Amounts;
  windowEnd: number;
}

export type Action =
  | { kind: "wait"; until: number; reason: string }
  | { kind: "skip"; until: number; reason: string }
  | { kind: "enter"; range: TickRange; deposit: Amounts; idle: Amounts; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "exit"; nftId: string; reason: "window_closing" | "drift" | "mandate_expired" | "event" };

export interface PlanInput {
  now: number;
  asset: StreamAsset;
  signal: Signal;
  mandate: Mandate;
  inventory: Amounts;
  position: OpenPosition | null;
  /** Corporate actions / earnings known for this asset (UTC ms). */
  events?: number[];
  /** Minimum time left in the window to make a cycle worth its gas. */
  minCycleMs?: number;
}

export function planCycle(i: PlanInput): Action {
  const { now, signal, mandate, position } = i;
  const minCycle = i.minCycleMs ?? 6 * 3_600_000;
  const inWindow = signal.clock.phase === "closed_window";
  const price = signal.price;

  if (position) {
    if (now >= mandate.expiresAt) return { kind: "exit", nftId: position.nftId, reason: "mandate_expired" };
    if (now >= Math.min(signal.exitAt, position.windowEnd)) return { kind: "exit", nftId: position.nftId, reason: "window_closing" };
    if (Math.abs(price / position.entryPrice - 1) >= mandate.exitOnDrift) return { kind: "exit", nftId: position.nftId, reason: "drift" };
    if (mandate.skipEvents && (i.events ?? []).some((e) => e >= position.openedAt && e <= position.windowEnd))
      return { kind: "exit", nftId: position.nftId, reason: "event" };
    return { kind: "hold", reason: "inside window, within drift" };
  }

  if (!i.asset.enabled) return { kind: "skip", until: signal.exitAt, reason: `${i.asset.symbol} is not enabled` };
  if (now >= mandate.expiresAt) return { kind: "skip", until: Infinity, reason: "mandate expired" };
  if (!inWindow || now < signal.entryAt) return { kind: "wait", until: signal.entryAt, reason: "market open — waiting for the closed window" };
  if (signal.exitAt - now < minCycle) return { kind: "skip", until: signal.exitAt, reason: "too little of the window left" };
  if (mandate.skipEvents && (i.events ?? []).some((e) => e >= signal.clock.window.start && e <= signal.clock.window.end))
    return { kind: "skip", until: signal.exitAt, reason: "corporate action / earnings inside the window" };

  const half = Math.min(signal.band.halfWidth, mandate.maxHalfWidth);
  const budget: Amounts = { stock: i.inventory.stock * mandate.allocation, usd: i.inventory.usd * mandate.allocation };
  if (budget.stock * price + budget.usd < 1) return { kind: "skip", until: signal.exitAt, reason: "nothing allocated" };

  const widthRatio = (1 + half) / (1 - half);
  const band = fitBandToInventory(price, widthRatio, budget);
  const range = snapRange(band.low, band.high, i.asset);
  const L = liquidityForInventory(budget, price, range.priceLow, range.priceHigh);
  const deposit = amountsAt(L, price, range.priceLow, range.priceHigh);
  const idle = { stock: budget.stock - deposit.stock, usd: budget.usd - deposit.usd };
  return { kind: "enter", range, deposit, idle, reason: `closed window (${signal.clock.window.reason}), ±${(half * 100).toFixed(2)}% band` };
}

/** River's cut: 5% of the LP fees earned in the cycle + a small fixed amount over gas (10% until 2026-09-29). */
export const RIVER_FEE = { share: 0.05, fixedUsd: 0.25 };
export const riverFee = (lpFeesUsd: number) => Math.max(0, lpFeesUsd) * RIVER_FEE.share + RIVER_FEE.fixedUsd;
