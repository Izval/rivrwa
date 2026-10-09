// gate.test.ts — the automatic Gate 0 and the live registry: the replay reproduces the published numbers, the
// rules reject what Gate 0 rejected by hand, and enabling/demotion follow the streak rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ASSETS, USDT, applyGate, assetFromPool, fillGaps, gateReport, mergeRegistry, pickPool, replay, resolveAsset, simulate, stats,
  type Candle, type GateReport, type StreamAsset,
} from "../src/index.ts";

const data = (f: string) => JSON.parse(fs.readFileSync(new URL(`../../../research/gate0/data/${f}`, import.meta.url), "utf8"));
const pools = data("pools.json");
const load = (sym: string) => {
  const a = ASSETS.find((x) => x.symbol === sym)!;
  const h1: Candle[] = fillGaps((data(`ohlcv_${sym}.json`) as number[][]).map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol })), 3600);
  return { asset: a, h1, snapshot: pools[a.pool] };
};

test("gate: replay reproduces the published production numbers (River fee 5% + $0.25)", () => {
  const nv = load("NVDAB"), ts = load("TSLAB");
  assert.equal(stats(replay(nv.asset, nv.h1, nv.snapshot)).apr.toFixed(1), "67.7");
  assert.equal(stats(replay(ts.asset, ts.h1, ts.snapshot)).apr.toFixed(1), "39.6");
  assert.equal(stats(replay(nv.asset, nv.h1, nv.snapshot, { mult: 4 })).apr.toFixed(1), "9.7");
});

test("gate: NVDAB and TSLAB pass, SPCXB fails as Gate 0 decided by hand", () => {
  for (const s of ["NVDAB", "TSLAB"]) assert.equal(gateReport({ ...load(s), tvlUsd: 1e6, decimalsOk: true }).pass, true, s);
  const sp = gateReport({ ...load("SPCXB"), tvlUsd: 1e6, decimalsOk: true });
  assert.equal(sp.pass, false);
  assert.ok(sp.reasons.some((r) => r.includes("windows gained")), "fails on consistency, not on its high APR");
  assert.ok(sp.warnings.some((w) => w.includes("unusually high")));
  const thin = gateReport({ ...load("NVDAB"), tvlUsd: 10_000, decimalsOk: false });
  assert.ok(thin.reasons.some((r) => r.includes("TVL")) && thin.reasons.some((r) => r.includes("decimals")));
});

const report = (pass: boolean): GateReport => ({
  at: 0, pass, reasons: pass ? [] : ["net APR 1.0% is below 3%"], warnings: [], ivlWindows: 5,
  base: { windows: 5, apr: pass ? 20 : 1, winRate: 80, worst: 0 }, x4: { windows: 5, apr: 1, winRate: 60, worst: 0 },
  weekday: { windows: 5, apr: -5, winRate: 20, worst: -1 }, tvlUsd: 1e5,
});
const cand: StreamAsset = { ...ASSETS[2], symbol: "GOOGLB", token: "0xabc", pinned: false, enabled: false };

test("registry: pass enables, two failures in a row demote, pinned never change", () => {
  const a1 = applyGate(cand, undefined, report(true));
  assert.equal(a1.enabled, true);
  const a2 = applyGate(cand, a1, report(false));
  assert.equal(a2.enabled, true, "one failure keeps it entering");
  const a3 = applyGate(cand, a2, report(false));
  assert.equal(a3.enabled, false, "the second failure in a row demotes");
  assert.equal(applyGate(cand, a3, report(true)).enabled, true, "comes back on the next pass");
  assert.equal(applyGate(cand, undefined, report(false)).enabled, false);
  const nv = ASSETS.find((x) => x.symbol === "NVDAB")!;
  assert.equal(applyGate(nv, undefined, report(false)).enabled, true);
});

test("registry: merge keeps pinned seed over stored copies and adds discovered stocks", () => {
  const nv = ASSETS.find((x) => x.symbol === "NVDAB")!;
  const list = mergeRegistry({ at: 0, status: {}, assets: [
    { ...nv, enabled: false, source: "auto", failStreak: 3 },
    { ...applyGate(cand, undefined, report(true)) },
  ] });
  assert.equal(resolveAsset(list, "nvdab")!.enabled, true);
  assert.equal(resolveAsset(list, "GOOGLB")!.enabled, true);
  assert.equal(resolveAsset(list, "SPCXB")!.enabled, false, "unreviewed seed candidates stay off");
  assert.equal(mergeRegistry(null).filter((a) => a.enabled).length, 2);
});

test("registry: pool pick and orientation come from USDT pairs and the chain", () => {
  const items = [
    { defiProtocolId: "uniswap3", protocolName: "", investmentId: "u", investmentName: "GOOGLB-USDT", apyDisplay: "", tvl: "900000" },
    { defiProtocolId: "pancakeswap3", protocolName: "", investmentId: "b", investmentName: "GOOGLB-BNB", apyDisplay: "", tvl: "800000" },
    { defiProtocolId: "pancakeswap3", protocolName: "", investmentId: "small", investmentName: "GOOGLB-USDT", apyDisplay: "", tvl: "50000" },
    { defiProtocolId: "pancakeswap3", protocolName: "", investmentId: "big", investmentName: "GOOGLB-USDT", apyDisplay: "", tvl: "1621264" },
  ];
  assert.equal(pickPool(items, "googlb")!.investmentId, "big");
  assert.equal(pickPool(items, "MSFTB"), null);
  const base = { symbol: "GOOGLB", underlying: "GOOGL", token: "0xAAA", pool: "0xP", investmentId: "big", fee: 0.0025, tickSpacing: 50 };
  assert.equal(assetFromPool({ ...base, token0: "0xaaa", token1: USDT })!.stockIsToken0, true);
  assert.equal(assetFromPool({ ...base, token0: USDT, token1: "0xaaa" })!.stockIsToken0, false);
  assert.equal(assetFromPool({ ...base, token0: "0xaaa", token1: "0xbnb" }), null);
});

test("gate: weekday returns are reported for context and are never a reason", () => {
  const nv = gateReport({ ...load("NVDAB"), tvlUsd: 1e6, decimalsOk: true });
  assert.ok(nv.weekday.apr > 0 && nv.pass);
  assert.ok(!nv.reasons.some((r) => /weekday/.test(r)));
});

test("simulate: same replay as the headline, with a USD breakdown that adds up", () => {
  const { asset, h1, snapshot } = load("NVDAB");
  const sim = simulate(asset, h1, snapshot, 10_000);
  assert.equal(sim.scenarios.x1.apr.toFixed(1), "67.7");
  assert.ok(sim.scenarios.x1.apr > sim.scenarios.x2.apr && sim.scenarios.x2.apr > sim.scenarios.x4.apr);
  assert.equal(sim.windows.length, 8);
  for (const w of sim.windows) assert.ok(Math.abs(w.feesUsd! - w.ilUsd! - w.costsUsd! - w.netUsd!) < 1e-9);
  assert.ok(sim.perWindowUsd.x1 > 0);
});
