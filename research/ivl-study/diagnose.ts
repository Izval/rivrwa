// Why A1 == A2, why C1 always abstains, and how robust B1 is.
import fs from "node:fs";
import { fillGaps, computeIVL, decideLP, aggregate, type Candle } from "../../packages/core/src/index.ts";
const DATA = new URL("../gate0/data/", import.meta.url), H = 3600;
const load = (s: string): Candle[] => fillGaps((JSON.parse(fs.readFileSync(new URL(`ohlcv_${s}.json`, DATA), "utf8")) as number[][]).map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol })), H);
const rebase = (cs: Candle[]) => { const p0 = cs[0].o; return cs.map((c) => ({ ...c, o: c.o / p0, h: c.h / p0, l: c.l / p0, c: c.c / p0 })); };
const ivl = (cs: Candle[]) => { const real = cs.filter((c) => !c.filled); const r = computeIVL({ "1h": real, "4h": aggregate(cs, 4) }, { primaryScale: "1h", gamma: 0.0025 }); const d = decideLP(r, real);
  const m = r.metricsByScale["1h"]; return { score: r.ivlScore, raw: +r.ivl.raw_primary.toFixed(4), lvr: r.lvr.level, sigmaB: +m.sigmaB.toFixed(4), sigmaRel: +(m.sigma / m.mu * 100).toFixed(2), Wpct: +(m.widthPct * 100).toFixed(2), fractal: +r.ivl.fractal.toFixed(2), action: d.action, risk: d.breakoutRisk }; };
for (const sym of ["NVDAB", "TSLAB"]) {
  const h1 = load(sym);
  const sats = h1.filter((c) => new Date(c.ts * 1000).getUTCDay() === 6 && new Date(c.ts * 1000).getUTCHours() === 1).map((c) => c.ts);
  const wins = sats.map((a) => h1.filter((c) => c.ts >= a && c.ts <= a + 45 * H)).filter((w) => w.length > 40);
  console.log(`\n## ${sym}: IVL on the last 4 closed windows before each weekend`);
  for (let i = 4; i < wins.length; i++) {
    const past = wins.slice(i - 4, i);
    console.log(new Date(wins[i][0].ts * 1000).toISOString().slice(0, 10), "concat:", JSON.stringify(ivl(past.flat())), "\n           rebased:", JSON.stringify(ivl(past.flatMap(rebase))));
  }
  console.log(`## ${sym}: IVL on single windows (each weekend alone)`);
  for (const w of wins) console.log(new Date(w[0].ts * 1000).toISOString().slice(0, 10), JSON.stringify(ivl(w)));
  const a = sats[sats.length - 1];
  console.log(`## ${sym}: IVL on the 168h before the last weekend`, JSON.stringify(ivl(h1.filter((c) => c.ts >= a - 168 * H && c.ts < a))));
}
