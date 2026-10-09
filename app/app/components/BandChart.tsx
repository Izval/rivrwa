// BandChart.tsx — one price axis with the signal's band (where River would place liquidity now), the position's
// actual range when one is open, the entry price, and the live price. Reads left to right in USD per share.

import { bandGeometry } from "../lib/band.ts";
import { num, usd } from "../lib/format.ts";

interface Props {
  price: number;
  band: { low: number; high: number; halfWidth: number };
  range?: { priceLow: number; priceHigh: number } | null;
  entryPrice?: number | null;
}

const span = (a: number, b: number) => ({ left: `${a * 100}%`, width: `${Math.max(0.4, (b - a) * 100)}%` });

export function BandChart({ price, band, range, entryPrice }: Props) {
  const g = bandGeometry({ price, band, range, entryPrice });
  const px = g.x(price);
  return (
    <figure className="m-0" aria-label={`Price ${usd(price)}; band ${usd(band.low)} to ${usd(band.high)}${range ? `; position ${usd(range.priceLow)} to ${usd(range.priceHigh)}` : ""}`}>
      <div className="relative h-7">
        <span className="tnum absolute bottom-0 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-2 py-0.5 text-[13px] font-semibold text-white" style={{ left: `${px * 100}%` }}>
          {usd(price)}
        </span>
      </div>
      <div className="relative mt-1.5 h-12">
        <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
        <div className="absolute inset-y-1 rounded-[10px] border border-river/50 bg-river-mist" style={span(g.x(band.low), g.x(band.high))} />
        {range && <div className="river-flow absolute inset-y-3.5 rounded-md" style={span(g.x(range.priceLow), g.x(range.priceHigh))} />}
        {entryPrice ? <span className="absolute inset-y-0 border-l border-dashed border-ink-2" style={{ left: `${g.x(entryPrice) * 100}%` }} /> : null}
        <span className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${px * 100}%` }} />
      </div>
      <div className="relative mt-1 h-5 text-[12px] text-ink-3">
        {g.ticks.map((t) => (
          <span key={t} className="tnum absolute -translate-x-1/2" style={{ left: `${g.x(t) * 100}%` }}>{num(t, t >= 100 ? 0 : 1)}</span>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-river/50 bg-river-mist" />Band now ±{(band.halfWidth * 100).toFixed(1)}%</span>
        {range && <span className="inline-flex items-center gap-1.5"><span className="river-flow h-2.5 w-4 rounded-sm" />Your position</span>}
        {entryPrice ? <span className="inline-flex items-center gap-1.5"><span className="h-3 border-l border-dashed border-ink-2" />Entry {usd(entryPrice)}</span> : null}
        <span className={g.inBand ? "text-ink-2" : "font-semibold text-warn"}>{g.inBand ? "Price inside the band" : "Price outside the band"}</span>
      </figcaption>
    </figure>
  );
}
