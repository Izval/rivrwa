// Gate 0 replay with the PRODUCTION signal + planner (packages/core). The replay itself lives in core
// (packages/core/src/gate.ts) so the discovery cron enables stocks with exactly this code.
import fs from "node:fs";
import { ASSETS, fillGaps, gateReport, replay, stats, type Candle } from "../../packages/core/src/index.ts";
const pools = JSON.parse(fs.readFileSync(new URL("./data/pools.json", import.meta.url), "utf8"));
const H = 3600;
const load = (sym: string) => {
  const a = ASSETS.find((x) => x.symbol === sym)!;
  const raw = JSON.parse(fs.readFileSync(new URL(`./data/ohlcv_${sym}.json`, import.meta.url), "utf8")) as number[][];
  const h1: Candle[] = fillGaps(raw.map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol })), H);
  return { a, h1, snapshot: pools[a.pool] };
};
for (const sym of ["NVDAB", "TSLAB"]) {
  const { a, h1, snapshot } = load(sym);
  for (const mult of [1, 2, 4]) {
    const s = stats(replay(a, h1, snapshot, { sizeUsd: 10_000, mult }));
    console.log(`${sym} others×${mult}  production (IVL μ±2σ): ${s.apr.toFixed(1)}% (n=${s.windows}, win ${s.winRate.toFixed(0)}%, worst ${s.worst.toFixed(2)}%)`);
  }
}
for (const sym of ["NVDAB", "TSLAB", "SPCXB"]) {
  const { a, h1, snapshot } = load(sym);
  const g = gateReport({ asset: a, h1, snapshot, tvlUsd: null, decimalsOk: true });
  console.log(`gate ${sym}: ${g.pass ? "PASS" : "FAIL"} (ivl windows ${g.ivlWindows}, base ${g.base.apr.toFixed(1)}%, ×4 ${g.x4.apr.toFixed(1)}%, weekday ${g.weekday.apr.toFixed(1)}%)${g.reasons.length ? " — " + g.reasons.join("; ") : ""}`);
}
console.table(replay(load("NVDAB").a, load("NVDAB").h1, load("NVDAB").snapshot));
