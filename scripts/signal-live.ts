// Live smoke test: compute today's River signal for every enabled asset (read-only, keyless).
import { ASSETS, fetchOhlcv, fillGaps, computeSignal } from "../packages/core/src/index.ts";
for (const a of ASSETS.filter((x) => x.enabled)) {
  const h1 = fillGaps(await fetchOhlcv(a.pool, a.token, "1h", 1000), 3600);
  const s = computeSignal(h1);
  console.log(a.symbol, JSON.stringify({
    price: +s.price.toFixed(2), phase: s.clock.phase, window: s.clock.window.reason,
    entry: new Date(s.entryAt).toISOString(), exit: new Date(s.exitAt).toISOString(),
    band: [+s.band.low.toFixed(2), +s.band.high.toFixed(2)], halfWidthPct: +(s.band.halfWidth * 100).toFixed(2), basis: s.band.basis,
    ivl: s.ivl, history: s.history.map((h) => `${h.window}:${(h.maxExcursion * 100).toFixed(2)}%`),
  }, null, 0));
  await new Promise((r) => setTimeout(r, 2500));
}
