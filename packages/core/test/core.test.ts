import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closedWindowAt, clockState, closedWindowsBetween, etToUtc,
  amountsAt, liquidityForValue, fitBandToInventory, snapRange, impermanentLoss,
  planCycle, riverFee, assetBySymbol, computeSignal, fillGaps, type Mandate, type Candle,
} from "../src/index.ts";

const iso = (ms: number) => new Date(ms).toISOString();

test("clock: a normal weekend runs Fri 20:00 ET → Sun 20:00 ET (EDT = UTC-4)", () => {
  const w = closedWindowAt(Date.parse("2026-09-26T12:00:00Z")); // Saturday
  assert.equal(iso(w.start), "2026-09-26T00:00:00.000Z");
  assert.equal(iso(w.end), "2026-09-28T00:00:00.000Z");
  assert.equal(w.reason, "weekend");
  assert.equal(w.hours, 48);
});

test("clock: Labor Day extends the window to Mon 20:00 ET", () => {
  const w = closedWindowAt(Date.parse("2026-09-06T12:00:00Z"));
  assert.equal(iso(w.end), "2026-09-08T00:00:00.000Z");
  assert.equal(w.reason, "weekend+holiday");
  assert.equal(w.hours, 72);
});

test("clock: DST ends 1-Nov-2026, the following weekend uses EST (UTC-5)", () => {
  const w = closedWindowAt(Date.parse("2026-11-07T12:00:00Z"));
  assert.equal(iso(w.start), "2026-11-07T01:00:00.000Z");
  assert.equal(iso(w.end), "2026-11-09T01:00:00.000Z");
});

test("clock: Thanksgiving (Thu) creates a mid-week 24h window", () => {
  const w = closedWindowAt(Date.parse("2026-11-26T15:00:00Z"));
  assert.equal(w.lastTradingDay, "2026-11-25");
  assert.equal(w.nextTradingDay, "2026-11-27");
  assert.equal(w.hours, 24);
});

test("clock: on a weekday the phase is open and points at the next window", () => {
  const s = clockState(Date.parse("2026-09-30T15:00:00Z")); // Wednesday
  assert.equal(s.phase, "open");
  assert.equal(iso(s.window.start), "2026-10-03T00:00:00.000Z");
  assert.ok(s.msToBoundary > 0);
});

test("clock: closedWindowsBetween lists one window per weekend", () => {
  const ws = closedWindowsBetween(Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(ws.length, 5); // Aug 1, 8, 15, 22, 29
  assert.equal(etToUtc("2026-08-07", 20), Date.parse("2026-08-08T00:00:00Z"));
});

test("v3: value is conserved at entry and composition flips at the edges", () => {
  const L = liquidityForValue(10_000, 230, 225, 235);
  const a = amountsAt(L, 230, 225, 235);
  assert.ok(Math.abs(a.stock * 230 + a.usd - 10_000) < 1e-6);
  assert.equal(amountsAt(L, 240, 225, 235).stock, 0);
  assert.equal(amountsAt(L, 220, 225, 235).usd, 0);
  assert.ok(impermanentLoss(a, amountsAt(L, 233, 225, 235), 233) > 0);
});

test("v3: fitBandToInventory matches the wallet's token ratio (no swap needed)", () => {
  const inv = { stock: 10, usd: 1000 }; // ~30% USD at $230
  const { low, high } = fitBandToInventory(230, 1.04, inv);
  const u = amountsAt(1, 230, low, high);
  const share = u.usd / (u.usd + u.stock * 230);
  assert.ok(Math.abs(share - 1000 / (1000 + 2300)) < 1e-6);
  assert.ok(low < 230 && high > 230);
});

test("v3: snapRange respects orientation and tick spacing", () => {
  const nv = snapRange(225, 235, assetBySymbol("NVDAB")!); // stock = token0
  const ts = snapRange(350, 370, assetBySymbol("TSLAB")!); // stock = token1
  assert.equal(nv.tickLower % 50, 0);
  assert.ok(nv.tickLower < nv.tickUpper && nv.priceLow <= 225 && nv.priceHigh >= 235);
  assert.ok(ts.tickLower < 0 && ts.tickLower < ts.tickUpper && ts.priceLow <= 350 && ts.priceHigh >= 370);
});

// Synthetic hourly series: weekends oscillate ±0.8% around 230, weekdays trend.
function series(fromIso: string, hours: number): Candle[] {
  const t0 = Date.parse(fromIso) / 1000;
  return fillGaps(Array.from({ length: hours }, (_, i) => {
    const ts = t0 + i * 3600;
    const dow = new Date(ts * 1000).getUTCDay();
    const c = dow === 0 || dow === 6 ? 230 * (1 + 0.008 * Math.sin(i / 3)) : 230 * (1 + 0.0004 * (i % 48));
    return { ts, o: c, h: c * 1.001, l: c * 0.999, c, vol: 50_000 };
  }), 3600);
}

const mandate: Mandate = {
  owner: "0xabc", asset: "NVDAB", allocation: 0.5, maxHalfWidth: 0.05, exitOnDrift: 0.03,
  skipEvents: true, restoreShares: true, expiresAt: Date.parse("2026-12-31T00:00:00Z"),
};

test("signal: IVL μ±2σ band from previous weekends, entry/exit inside the window", () => {
  const now = Date.parse("2026-10-03T03:00:00Z"); // Saturday, window open since 00:00 UTC
  const s = computeSignal(series("2026-08-24T00:00:00Z", 24 * 40 + 3), now);
  assert.equal(s.clock.phase, "closed_window");
  assert.equal(s.band.basis, "ivl_2sigma");
  assert.ok(s.ivl.sigmaPct! > 0 && s.ivl.windows === 4);
  assert.ok(Math.abs(s.band.halfWidth - 2 * s.ivl.sigmaPct! / 100) < 1e-9 || s.band.halfWidth === 0.005, `halfWidth ${s.band.halfWidth}`);
  assert.ok(s.band.halfWidth < 0.03);
  assert.equal(iso(s.entryAt), "2026-10-03T01:00:00.000Z");
  assert.equal(iso(s.exitAt), "2026-10-04T22:00:00.000Z");
});

test("planner: enter → hold → exit around one weekend", () => {
  const asset = assetBySymbol("NVDAB")!;
  const candles = series("2026-08-24T00:00:00Z", 24 * 40 + 3);
  const sat = Date.parse("2026-10-03T03:00:00Z");
  const sig = computeSignal(candles, sat);
  const enter = planCycle({ now: sat, asset, signal: sig, mandate, inventory: { stock: 20, usd: 3000 }, position: null });
  assert.equal(enter.kind, "enter");
  if (enter.kind !== "enter") return;
  assert.ok(enter.deposit.stock <= 10 + 1e-9 && enter.deposit.usd <= 1500 + 1e-9); // 50% allocation
  const pos = { nftId: "1", openedAt: sat, entryPrice: sig.price, range: enter.range, entryAmounts: enter.deposit, windowEnd: sig.clock.window.end };
  assert.equal(planCycle({ now: sat + 3_600_000, asset, signal: sig, mandate, inventory: { stock: 0, usd: 0 }, position: pos }).kind, "hold");
  const late = computeSignal(candles, Date.parse("2026-10-04T22:30:00Z"));
  const exit = planCycle({ now: Date.parse("2026-10-04T22:30:00Z"), asset, signal: late, mandate, inventory: { stock: 0, usd: 0 }, position: pos });
  assert.deepEqual(exit, { kind: "exit", nftId: "1", reason: "window_closing" });
});

test("planner: waits on weekdays, skips disabled assets and event windows", () => {
  const candles = series("2026-08-24T00:00:00Z", 24 * 40 + 3);
  const wed = Date.parse("2026-09-30T15:00:00Z");
  const sig = computeSignal(candles.filter((c) => c.ts * 1000 <= wed), wed);
  assert.equal(planCycle({ now: wed, asset: assetBySymbol("NVDAB")!, signal: sig, mandate, inventory: { stock: 1, usd: 100 }, position: null }).kind, "wait");
  const sat = Date.parse("2026-10-03T03:00:00Z");
  const s2 = computeSignal(candles, sat);
  assert.equal(planCycle({ now: sat, asset: assetBySymbol("SPCXB")!, signal: s2, mandate, inventory: { stock: 1, usd: 100 }, position: null }).kind, "skip");
  const ev = planCycle({ now: sat, asset: assetBySymbol("NVDAB")!, signal: s2, mandate, inventory: { stock: 1, usd: 100 }, position: null, events: [Date.parse("2026-10-03T12:00:00Z")] });
  assert.equal(ev.kind, "skip");
});

test("fee: River takes 5% of LP fees + $0.25", () => {
  assert.equal(riverFee(100), 5.25);
  assert.equal(riverFee(-5), 0.25);
});

test("signal: falls back to the excursion band when there is too little closed-window history", () => {
  const now = Date.parse("2026-10-03T03:00:00Z");
  const s = computeSignal(series("2026-09-24T00:00:00Z", 24 * 9 + 3), now); // one past weekend only
  assert.equal(s.band.basis, "fallback");
  assert.equal(s.ivl.score, null);
});
