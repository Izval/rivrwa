// simulation.ts — the shape of rivrwa-api /v1/simulate as the landing uses it. The numbers are River's replay of
// the stock's past closed windows at the chosen size (packages/core/src/gate.ts `simulate`), net of LP-fee share,
// impermanent loss, gas, River's fee and restoring the share count. The stock's own return comes on top.

export interface SimStats { windows: number; apr: number; winRate: number; worst: number }

export interface SimWindow {
  window: string;
  netPct: number;
  feesUsd: number;
  ilUsd: number;
  costsUsd: number;
  netUsd: number;
}

export interface Simulation {
  symbol: string;
  reviewedAt: number;
  sizeUsd: number;
  scenarios: { x1: SimStats; x2: SimStats; x4: SimStats };
  perWindowUsd: { x1: number; x2: number; x4: number };
  windows: SimWindow[];
}

export type Competition = 1 | 2 | 4;
export const COMPETITION: { x: Competition; label: string }[] = [
  { x: 1, label: "Today's liquidity" },
  { x: 2, label: "2× competition" },
  { x: 4, label: "4× competition" },
];

/** A closed window happens about once a week (holidays make a few longer), so a year is ~52 of them. */
export const WINDOWS_PER_YEAR = 52;

export const clampSize = (n: number) => Math.min(1_000_000, Math.max(100, Number.isFinite(n) ? n : 10_000));
