// api.server.ts — the app's client for the public API (rivrwa-api): the live signal per asset and the backtest.
// Failures return null so a page renders with what it has; the market clock is computed locally and never fails.

import { env } from "cloudflare:workers";
import type { Signal } from "../../../packages/core/src/signal.ts";
import { callWorker } from "./binding.server.ts";
import type { StockListing } from "./stocks.ts";
import type { Competition, Simulation } from "./simulation.ts";

export type { Signal };

export interface Backtest {
  source: string;
  ivl: string;
  costs: string;
  sizeUsd: number;
  rows: { asset: string; windows: number; netAprBase: number; netAprOthersX2: number; netAprOthersX4: number; winRateBase: number }[];
  control: string;
  caveats: string[];
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await callWorker(env.API, env.API_URL, path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const signals = async () => (await get<{ symbol: string; signal: Signal }[]>("/v1/signals")) ?? [];
export const signal = async (symbol: string) => (await get<{ symbol: string; signal: Signal }>(`/v1/signal/${symbol}`))?.signal ?? null;
export const backtest = () => get<Backtest>("/v1/backtest");
/** One entry of the live registry (rivrwa-api /v1/assets): pinned seed plus stocks enabled by the automatic gate. */
export interface RegistryEntry {
  symbol: string;
  underlying: string;
  token: string;
  enabled: boolean;
  source: "pinned" | "auto";
  note?: string;
  gate?: { pass: boolean; reasons: string[]; ivlWindows: number; base: { apr: number; windows: number; winRate: number } } | null;
}
export const assets = async () => (await get<{ assets: RegistryEntry[] }>("/v1/assets"))?.assets ?? null;
export const simulation = (symbol: string, size: number, x: Competition) =>
  get<Simulation>(`/v1/simulate?symbol=${encodeURIComponent(symbol)}&size=${Math.round(size)}&x=${x}`);
export const stocks = () => get<{ asOf: number; source: string; stocks: StockListing[] }>("/v1/stocks");

/** River as an agent (rivrwa-api /v1/agent): ERC-8004 identity, treasury and the public cycle ledger. */
export interface AgentView {
  identity: { standard: string; registry: string; agentId: number | null; owner: string | null; scan: string | null; registration: string };
  wallet: { address: string; bnb: number | null; usdt: number | null } | null;
  pricing: { planUsd: number; rails: string[] };
  treasury: { paidCalls: number; revenueUsd: number; byRail: Record<string, number>; recent: { at: number; rail: string; usd: number; payer: string | null; tx: string | null; resource: string }[] };
  cycles: { asset: string; owner: string; openedAt: string; closedAt: string; feesUsd: number; txs: { add: string; claim?: string; remove: string } }[];
}
export const agent = () => get<AgentView>("/v1/agent");
