// IVL study — does IVL improve River's cycle, and how should it be used?
//
// Replays every 45h window (weekend = closed market; weekday = control) through several range
// policies built on packages/core, with the same cost model as Gate 0 (IL vs holding, gas per
// on-chain action, River 10% + $0.25, restore to the same share count). Deterministic.
//
//   A0 adaptive         p80 of past same-kind windows' max excursion ×1.2 (production today)
//   A1 ivl-concat-widen A0, ×1.5 when IVL on *concatenated raw* past windows says breakout=high
//                       (what production did before: the measurement bug under study)
//   A2 ivl-rebased-widen same, but each past window is rebased to its entry price first
//   B1 ivl-band-rebased band = ±2σ of the rebased past windows (IVL's canonical μ±2σ)
//   B2 ivl-band-168h    band = IVL μ±2σ on the 168h lookback (the original IVL study setup)
//   C1 ivl-gate-168h    A0 band, but abstain when IVL(168h) says withdraw_or_widen
//   D1 ivl-intra        A0 at entry; at +12h/+24h re-measure IVL on the window so far:
//                       concentrate → re-range to its μ±2σ (no swap); withdraw → exit early

import fs from "node:fs";
import {
  ASSETS, fillGaps, computeIVL, decideLP, aggregate, amountsAt, fitBandToInventory, liquidityForInventory,
  snapRange, riverFee, type Candle, type StreamAsset, type Amounts,
} from "../../packages/core/src/index.ts";

const H = 3600;
const GAS_TX = 0.3, RESTORE = 0.0035, SIZE = 10_000;
// Sweep knobs (defaults = the canonical IVL setup): σ multiple for B1 and past windows used.
const B1_K = Number(process.env.B1_K ?? 2), LOOKBACK = Number(process.env.LOOKBACK ?? 4);
const ONLY = process.env.ONLY?.split(",");
const DATA = new URL("../gate0/data/", import.meta.url);
const pools = JSON.parse(fs.readFileSync(new URL("pools.json", DATA), "utf8"));

function profile(p: any, mult: number) {
  const net = Object.entries(p.net as Record<string, string>).map(([t, n]) => [+t, BigInt(n)] as const).sort((a, b) => a[0] - b[0]);
  const L0 = BigInt(p.liquidity);
  return (tick: number) => {
    let L = L0;
    if (tick >= p.tick) { for (const [t, n] of net) if (t > p.tick && t <= tick) L += n; }
    else for (let i = net.length - 1; i >= 0; i--) { const [t, n] = net[i]; if (t <= p.tick && t > tick) L -= n; }
    return Number(L < 0n ? 0n : L) * mult;
  };
}

function loadCandles(sym: string): Candle[] {
  const raw = JSON.parse(fs.readFileSync(new URL(`ohlcv_${sym}.json`, DATA), "utf8")) as number[][];
  return fillGaps(raw.map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol })), H);
}

interface Win { kind: "weekend" | "weekday"; a: number; b: number; label: string }

/** Weekend: Sat 01:00 → Sun 22:00 UTC (+ holiday extension). Weekday: every Mon–Wed 01:00, same length. */
function windows(h1: Candle[]): Win[] {
  const HOL = ["2026-09-07"]; const out: Win[] = [];
  const first = Math.ceil(h1[0].ts / 86400) * 86400, last = h1[h1.length - 1].ts;
  for (let t = first; t <= last; t += 86400) {
    const dow = new Date(t * 1000).getUTCDay(), d = (x: number) => new Date(x * 1000).toISOString().slice(0, 10);
    if (dow === 6) { let b = t + 2 * 86400; if (HOL.includes(d(b))) b += 86400; out.push({ kind: "weekend", a: t + H, b: b - 2 * H, label: d(t) }); }
    if (dow >= 1 && dow <= 3 && !HOL.includes(d(t))) out.push({ kind: "weekday", a: t + H, b: t + 2 * 86400 - 2 * H, label: d(t) });
  }
  return out.filter((w) => w.b <= last);
}

const slice = (h1: Candle[], a: number, b: number) => h1.filter((c) => c.ts >= a && c.ts <= b);
const quant = (xs: number[], q: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
const excursion = (cs: Candle[]) => { const p0 = cs[0].o; return Math.max(...cs.map((c) => Math.max(Math.abs(c.h / p0 - 1), Math.abs(c.l / p0 - 1)))); };
const rebase = (cs: Candle[]) => { const p0 = cs[0].o; return cs.map((c) => ({ ...c, o: c.o / p0, h: c.h / p0, l: c.l / p0, c: c.c / p0 })); };

function ivlOf(cs: Candle[]) {
  const real = cs.filter((c) => !c.filled);
  if (real.length < 24) return null;
  const r = computeIVL({ "1h": real, "4h": aggregate(cs, 4) }, { primaryScale: "1h", gamma: 0.0025 });
  if (!r.ok) return null;
  const d = decideLP(r, real);
  return { r, d };
}

type Policy = "A0" | "A1" | "A2" | "B1" | "B2" | "C1" | "D1";
const POLICIES: Policy[] = ["A0", "A1", "A2", "B1", "B2", "C1", "D1"];

interface Row { win: Win; policy: Policy; deployed: boolean; netPct: number; fees: number; hw: number; ivlScore: number | null; note: string }

function simulate(asset: StreamAsset, h1: Candle[], byTs: Map<number, Candle>, w: Win, past: Win[], policy: Policy, Lo: (t: number) => number): Row {
  const p0 = byTs.get(w.a)!.c;
  const pastC = past.map((x) => slice(h1, x.a, x.b)).filter((cs) => cs.length >= 6);
  const ex = pastC.map(excursion);
  let hw = ex.length >= 2 ? Math.max(0.005, quant(ex, 0.8) * 1.2) : 0.03;
  let ivlScore: number | null = null, note = "";
  const look168 = slice(h1, w.a - 168 * H, w.a - H);

  if (policy === "A1" || policy === "A2") {
    const m = ivlOf(policy === "A1" ? pastC.flat() : pastC.flatMap(rebase));
    ivlScore = m?.r.ivlScore ?? null;
    if (m?.d.breakoutRisk === "high") { hw *= 1.5; note = "widened"; }
  }
  if (policy === "B1") {
    const m = ivlOf(pastC.flatMap(rebase));
    if (m) { ivlScore = m.r.ivlScore; hw = Math.max(0.005, B1_K * m.r.lpRange.sigma / m.r.lpRange.vwap); note = `μ±${B1_K}σ rebased`; }
  }
  if (policy === "B2" || policy === "C1") {
    const m = ivlOf(look168);
    if (m) {
      ivlScore = m.r.ivlScore;
      if (policy === "B2") { hw = Math.max(0.005, 2 * m.r.lpRange.sigma / m.r.lpRange.vwap); note = "μ±2σ 168h"; }
      if (policy === "C1" && m.d.action === "withdraw_or_widen")
        return { win: w, policy, deployed: false, netPct: 0, fees: 0, hw, ivlScore, note: "abstained" };
    }
  }

  // --- deploy (no-swap fit of a 50/50 inventory) ---
  const inv0: Amounts = { stock: SIZE / 2 / p0, usd: SIZE / 2 };
  let idle: Amounts = { stock: 0, usd: 0 };
  const open = (inv: Amounts, p: number, half: number) => {
    const band = fitBandToInventory(p, (1 + half) / (1 - half), inv);
    const r = snapRange(band.low, band.high, asset);
    const L = liquidityForInventory(inv, p, r.priceLow, r.priceHigh);
    const dep = amountsAt(L, p, r.priceLow, r.priceHigh);
    idle = { stock: idle.stock + inv.stock - dep.stock, usd: idle.usd + inv.usd - dep.usd };
    return { L, lo: r.priceLow, hi: r.priceHigh };
  };
  let pos = open(inv0, p0, hw);
  let gas = GAS_TX, fees = 0, exitAt = w.b;
  const checkpoints = policy === "D1" ? [w.a + 12 * H, w.a + 24 * H] : [];

  for (let t = w.a + H; t <= exitAt; t += H) {
    const k = byTs.get(t)!;
    if (k.c >= pos.lo && k.c <= pos.hi) {
      const tick = Math.floor(Math.log(asset.stockIsToken0 ? k.c : 1 / k.c) / Math.log(1.0001));
      fees += k.vol * asset.feeTier * (pos.L * 1e18) / (pos.L * 1e18 + Lo(tick));
    }
    if (checkpoints.includes(t)) {
      const m = ivlOf(slice(h1, w.a, t).length >= 11 ? slice(h1, w.a, t) : []) ?? (() => {
        // window-so-far is short (12–24 candles): relax the 24-candle floor for the intra check
        const cs = slice(h1, w.a, t).filter((c) => !c.filled);
        if (cs.length < 8) return null;
        const r = computeIVL({ "1h": cs }, { primaryScale: "1h", gamma: 0.0025 });
        return r.ok ? { r, d: decideLP(r, cs) } : null;
      })();
      if (m) {
        const held = amountsAt(pos.L, k.c, pos.lo, pos.hi);
        if (m.d.action === "withdraw_or_widen") { idle = { stock: idle.stock + held.stock, usd: idle.usd + held.usd }; pos = { L: 0, lo: 0, hi: 0 }; gas += GAS_TX; note += ` exit@${(t - w.a) / H}h`; exitAt = t; break; }
        if (m.d.action === "concentrate") {
          const half = Math.max(0.004, Math.min(hw, 2 * m.r.lpRange.sigma / k.c));
          pos = open(held, k.c, half); gas += 2 * GAS_TX; note += ` conc@${(t - w.a) / H}h ±${(half * 100).toFixed(2)}%`;
        }
      }
    }
  }
  const p1 = byTs.get(exitAt)!.c;
  const final = pos.L ? amountsAt(pos.L, p1, pos.lo, pos.hi) : { stock: 0, usd: 0 };
  const end = { stock: final.stock + idle.stock, usd: final.usd + idle.usd };
  const il = inv0.stock * p1 + inv0.usd - (end.stock * p1 + end.usd);
  const restore = Math.abs(end.stock - inv0.stock) * p1 * RESTORE;
  if (exitAt === w.b) gas += GAS_TX; // regular exit tx
  const net = fees - il - gas - riverFee(fees) - restore;
  return { win: w, policy, deployed: true, netPct: (net / SIZE) * 100, fees, hw, ivlScore, note: note.trim() };
}

function summarize(rows: Row[]) {
  const n = rows.length, dep = rows.filter((r) => r.deployed);
  const perWindow = rows.reduce((s, r) => s + r.netPct, 0) / n;
  const periodsPerYear = rows[0]?.win.kind === "weekend" ? 52 : 52; // one 45h window per week-equivalent
  return {
    n, deployed: dep.length, apr: perWindow * periodsPerYear,
    win: (rows.filter((r) => r.netPct > 0).length / n) * 100,
    worst: Math.min(...rows.map((r) => r.netPct)),
  };
}

const results: Record<string, unknown> = {};
for (const sym of ["NVDAB", "TSLAB"]) {
  const asset = ASSETS.find((a) => a.symbol === sym)!, h1 = loadCandles(sym), byTs = new Map(h1.map((c) => [c.ts, c]));
  const W = windows(h1).filter((w) => w.a - 168 * H >= h1[0].ts);
  for (const mult of [1, 2, 4]) {
    const Lo = profile(pools[asset.pool], mult);
    console.log(`\n### ${sym} · other-LP liquidity ×${mult} · $${SIZE / 1000}k · net APR per 45h window ×52`);
    console.log("policy".padEnd(22) + "weekend".padEnd(40) + "weekday");
    for (const pol of POLICIES.filter((p) => !ONLY || ONLY.includes(p))) {
      const cell = (kind: Win["kind"]) => {
        const ws = W.filter((w) => w.kind === kind);
        const rows = ws.map((w) => simulate(asset, h1, byTs, w, W.filter((x) => x.kind === kind && x.b < w.a).slice(-LOOKBACK), pol, Lo));
        results[`${sym}|${mult}|${pol}|${kind}`] = rows.map((r) => ({ w: r.win.label, net: +r.netPct.toFixed(3), hw: +(r.hw * 100).toFixed(2), ivl: r.ivlScore, dep: r.deployed, note: r.note }));
        const s = summarize(rows);
        return `${s.apr.toFixed(1).padStart(6)}% win${s.win.toFixed(0).padStart(4)}% worst${s.worst.toFixed(2).padStart(6)}% dep ${s.deployed}/${s.n}`.padEnd(40);
      };
      console.log(pol.padEnd(22) + cell("weekend") + cell("weekday"));
    }
  }
}
if (!ONLY) fs.writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 1));
