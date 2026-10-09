// band.ts — geometry for the band chart: one horizontal price axis holding the signal's IVL band, the position's
// actual range (when there is one) and the live price. The domain pads the widest of them so none touch the edge.

export interface BandInput {
  price: number;
  band: { low: number; high: number };
  range?: { priceLow: number; priceHigh: number } | null;
  entryPrice?: number | null;
}

export interface BandGeometry {
  min: number;
  max: number;
  /** Price → position on [0, 1]. */
  x: (p: number) => number;
  inBand: boolean;
  inRange: boolean | null;
  ticks: number[];
}

export function bandGeometry({ price, band, range, entryPrice }: BandInput, pad = 0.35): BandGeometry {
  const pts = [price, band.low, band.high, ...(range ? [range.priceLow, range.priceHigh] : []), ...(entryPrice ? [entryPrice] : [])];
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = Math.max(hi - lo, price * 0.01);
  const min = lo - span * pad, max = hi + span * pad;
  const x = (p: number) => Math.min(1, Math.max(0, (p - min) / (max - min)));
  return {
    min, max, x,
    inBand: price >= band.low && price <= band.high,
    inRange: range ? price >= range.priceLow && price <= range.priceHigh : null,
    ticks: niceTicks(min, max, 5),
  };
}

/** Round axis ticks inside [min, max] (1, 2, 2.5 or 5 × 10^k steps). */
export function niceTicks(min: number, max: number, target: number): number[] {
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}
