// v3.ts — concentrated-liquidity math, expressed in *stock price* (USD per share token).
//
// Pools differ in token order (NVDAB/USDT has the stock as token0, TSLAB/USDT as token1), so
// every function here takes stock-denominated prices and a `stockIsToken0` flag, and converts
// to the pool's token1/token0 price only where ticks are involved. Both legs are 18 decimals
// on BSC (bStocks and USDT), which the registry asserts.

export const TICK_BASE = 1.0001;

export interface PoolOrientation {
  stockIsToken0: boolean;
  tickSpacing: number;
}

/** stock USD price -> pool price (token1 per token0). */
export const toPoolPrice = (stockPrice: number, o: PoolOrientation) => (o.stockIsToken0 ? stockPrice : 1 / stockPrice);
/** pool tick -> stock USD price. */
export const tickToStockPrice = (tick: number, o: PoolOrientation) => {
  const p = Math.pow(TICK_BASE, tick);
  return o.stockIsToken0 ? p : 1 / p;
};

export interface TickRange {
  tickLower: number;
  tickUpper: number;
  /** Stock-price bounds of the snapped range. */
  priceLow: number;
  priceHigh: number;
}

/** Snap a stock-price band to deployable ticks (outward, so the band is fully covered). */
export function snapRange(priceLow: number, priceHigh: number, o: PoolOrientation): TickRange {
  if (!(priceLow > 0) || !(priceHigh > priceLow)) throw new Error("snapRange: invalid band");
  const a = Math.log(toPoolPrice(priceLow, o)) / Math.log(TICK_BASE);
  const b = Math.log(toPoolPrice(priceHigh, o)) / Math.log(TICK_BASE);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const s = o.tickSpacing;
  const tickLower = Math.floor(lo / s) * s;
  const tickUpper = Math.ceil(hi / s) * s;
  const p1 = tickToStockPrice(tickLower, o), p2 = tickToStockPrice(tickUpper, o);
  return { tickLower, tickUpper, priceLow: Math.min(p1, p2), priceHigh: Math.max(p1, p2) };
}

export interface Amounts {
  stock: number;
  usd: number;
}

/**
 * Token amounts held by `liquidity` units at stock price `p` for the band [low, high].
 * Uses the symmetric formulation in stock-price space: with S = sqrt(p),
 *   stock = L·(1/S − 1/Sh), usd = L·(S − Sl)   (clamped to the band).
 * This is exactly v3 in both orientations: with the stock as token1 the pool price is 1/p,
 * so token0 (USD) = L·(1/√P − 1/√Pb) = L·(√p − √low) and token1 (stock) = L·(1/√p − 1/√high).
 * L here equals the pool's liquidity (in whole-token units; ×1e18 for raw, both legs 18 dp).
 */
export function amountsAt(L: number, p: number, low: number, high: number): Amounts {
  const sl = Math.sqrt(low), sh = Math.sqrt(high);
  const s = Math.min(Math.max(Math.sqrt(p), sl), sh);
  return { stock: L * (1 / s - 1 / sh), usd: L * (s - sl) };
}

/** Liquidity units for a position worth `valueUsd` at price p in [low, high]. */
export function liquidityForValue(valueUsd: number, p: number, low: number, high: number): number {
  const unit = amountsAt(1, p, low, high);
  return valueUsd / (unit.stock * p + unit.usd);
}

/** Largest position (liquidity units) that fits inside an inventory without any swap. */
export function liquidityForInventory(inv: Amounts, p: number, low: number, high: number): number {
  const unit = amountsAt(1, p, low, high);
  const byStock = unit.stock > 0 ? inv.stock / unit.stock : Infinity;
  const byUsd = unit.usd > 0 ? inv.usd / unit.usd : Infinity;
  return Math.min(byStock, byUsd);
}

/**
 * No-swap fit: given a band *width* (high/low ratio from IVL) and the user's inventory, find
 * the band position around price p whose token ratio matches the inventory, so the whole
 * allocation deposits with zero swaps (zero price impact). The shift is bounded so p stays
 * inside the band with at least `minEdge` of the log-width on each side; if the inventory is
 * too one-sided for that, the bound is used and the excess stays idle in the wallet.
 */
export function fitBandToInventory(p: number, widthRatio: number, inv: Amounts, minEdge = 0.15): { low: number; high: number } {
  if (!(widthRatio > 1)) throw new Error("fitBandToInventory: widthRatio must be > 1");
  const logW = Math.log(widthRatio);
  // f = fraction of the log-width below p; f → 0 means all-stock, f → 1 all-usd.
  const usdShare = (f: number) => {
    const low = p * Math.exp(-f * logW), high = low * widthRatio;
    const a = amountsAt(1, p, low, high);
    return a.usd / (a.usd + a.stock * p);
  };
  const target = inv.usd / (inv.usd + inv.stock * p || 1);
  let lo = minEdge, hi = 1 - minEdge;
  if (target <= usdShare(lo)) hi = lo;
  else if (target >= usdShare(hi)) lo = hi;
  for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    if (usdShare(mid) < target) lo = mid; else hi = mid;
  }
  const f = (lo + hi) / 2;
  const low = p * Math.exp(-f * logW);
  return { low, high: low * widthRatio };
}

/** Value of a position vs simply holding its entry amounts (impermanent loss, USD, ≥ 0 ideally). */
export function impermanentLoss(entry: Amounts, exit: Amounts, pExit: number): number {
  return entry.stock * pExit + entry.usd - (exit.stock * pExit + exit.usd);
}
