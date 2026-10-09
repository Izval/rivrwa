// assets.ts — the river's first stream: bStocks paired with USDT on PancakeSwap v3 (BSC).
//
// Addresses and investmentIds come from the Binance Web3 API (RWA Data `rwa/tokens` and DeFi
// `investment/list|detail`), verified 2026-09-28. Token order was read on-chain from the pools.

import type { PoolOrientation } from "./v3.ts";

export const CHAIN_ID = 56;
export const USDT = "0x55d398326f99059ff775485246999027b3197955";
/** PancakeSwap v3 NonfungiblePositionManager (BSC), as returned by the DeFi API lp-add builder. */
export const PANCAKE_V3_NPM = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364";

export interface StreamAsset extends PoolOrientation {
  symbol: string;
  underlying: string;
  token: string;
  decimals: 18;
  pool: string;
  /** Binance DeFi API investment id for this pool. */
  investmentId: string;
  feeTier: number;
  /** Whether River runs cycles on it. Disabled assets are shown, not operated. */
  enabled: boolean;
  /** Pinned assets stay enabled whatever the automatic gate says (registry.ts). */
  pinned?: boolean;
  note?: string;
}

/** The seed registry. NVDAB and TSLAB are pinned; everything else, SPCXB included, is enabled or not by the
 *  automatic gate (registry.ts, workers/api discovery). Deployed code reads the merged registry from KV. */
export const ASSETS: readonly StreamAsset[] = [
  {
    symbol: "NVDAB", underlying: "NVDA", token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", decimals: 18,
    pool: "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c",
    investmentId: "9c97dee13d719c679a1d91e22612ee3520eca470004c907c22d405de7ec7f79d",
    feeTier: 0.0025, tickSpacing: 50, stockIsToken0: true, enabled: true, pinned: true,
  },
  {
    symbol: "TSLAB", underlying: "TSLA", token: "0x5b1910eaad6450e50f816082aa078c41f10c292f", decimals: 18,
    pool: "0xb0f5e5400e8f0f7c242f2b7740c004f020579c41",
    investmentId: "72e73da9afc69f6b257f59eda4982815ca9c0ff6a0098267547c92e0c29f7761",
    feeTier: 0.0025, tickSpacing: 50, stockIsToken0: false, enabled: true, pinned: true,
  },
  {
    symbol: "SPCXB", underlying: "SPCX", token: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", decimals: 18,
    pool: "0x977daffc095b33872e2741c19568925015c35b4d",
    investmentId: "c1d7d6777f3c7dbf94f8a29ce70b7c2db6b03818020274be3f9a481b208cf07d",
    feeTier: 0.0025, tickSpacing: 50, stockIsToken0: false, enabled: false,
    note: "Under automatic review: Gate 0 found returns implausible even on weekdays.",
  },
];

export const assetBySymbol = (s: string) => ASSETS.find((a) => a.symbol === s.toUpperCase());
