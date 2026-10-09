// lib.test.ts — the app's pure helpers: formatting, profiles, band geometry and the week strip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { closedWindowAt } from "../../../packages/core/src/clock.ts";
import { duration, shares, shortAddr, signedPct, usd } from "./format.ts";
import { DEFAULT_PROFILE, PROFILES, profileOf } from "./profiles.ts";
import { bandGeometry, niceTicks } from "./band.ts";
import { weekStrip } from "./week.ts";

test("format: money, percent, shares, durations", () => {
  assert.equal(usd(1234.5), "$1,234.50");
  assert.equal(usd(-3), "−$3.00");
  assert.equal(signedPct(0.0123), "+1.23%");
  assert.equal(signedPct(-0.004), "−0.40%");
  assert.equal(shares(2.5), "2.5000");
  assert.equal(shares(120), "120.00");
  assert.equal(shortAddr("0xc0cb000000000000000000000000000000093c3"), "0xc0cb…93c3");
  assert.equal(duration(2 * 86400_000 + 4 * 3600_000 + 5_000), "2d 4h");
  assert.equal(duration(3 * 3600_000 + 7 * 60_000), "3h 07m");
  assert.equal(duration(65_000), "1m 05s");
  assert.equal(duration(-1), "0m 00s");
});

test("profiles: presets are valid mandate knobs and round-trip", () => {
  for (const p of PROFILES) {
    assert.ok(p.maxHalfWidth > 0 && p.maxHalfWidth < 0.5);
    assert.ok(p.exitOnDrift > 0);
    assert.equal(profileOf(p.maxHalfWidth, p.exitOnDrift), p);
  }
  assert.equal(DEFAULT_PROFILE.id, "base");
  assert.equal(profileOf(0.04, 0.03), null);
});

test("band: domain holds band, range and price; flags", () => {
  const g = bandGeometry({ price: 100, band: { low: 97, high: 103 }, range: { priceLow: 98, priceHigh: 104 } });
  assert.ok(g.min < 97 && g.max > 104);
  assert.ok(g.x(97) > 0 && g.x(104) < 1);
  assert.equal(g.x(g.min - 50), 0);
  assert.ok(g.inBand && g.inRange);
  assert.equal(bandGeometry({ price: 110, band: { low: 97, high: 103 } }).inBand, false);
  assert.deepEqual(niceTicks(95, 105, 5), [96, 98, 100, 102, 104]);
});

test("week strip: window, entry and exit in order; now only when inside", () => {
  const w = closedWindowAt(Date.parse("2026-10-02T12:00:00Z")); // the 3–4 Oct weekend
  const s = weekStrip(w, Date.parse("2026-10-03T12:00:00Z"));
  assert.ok(0 < s.windowStart && s.windowStart < s.entry && s.entry < s.exit && s.exit < s.windowEnd && s.windowEnd < 1);
  assert.ok(s.now! > s.entry && s.now! < s.exit);
  assert.ok(s.days.length >= 3 && s.days.every((d) => d.x >= 0 && d.x <= 1));
  assert.deepEqual(s.days.map((d) => d.label).slice(0, 4), ["Fri", "Sat", "Sun", "Mon"]);
  assert.equal(weekStrip(w, Date.parse("2026-09-29T12:00:00Z")).now, null);
});

test("stocks: grouped by underlying, running first, searchable", async () => {
  const { groupStocks, matches } = await import("./stocks.ts");
  const rows = groupStocks([
    { symbol: "AMDon", underlying: "AMD", issuer: "Ondo", token: "0x1", price: 608, river: "watching" },
    { symbol: "AMDB", underlying: "AMD", issuer: "bStocks", token: "0x2", price: 609, river: "watching" },
    { symbol: "NVDAB", underlying: "NVDA", issuer: "bStocks", token: "0x3", price: 228, river: "running" },
  ]);
  assert.deepEqual(rows.map((r) => r.underlying), ["NVDA", "AMD"]);
  assert.equal(rows[1].tokens.length, 2);
  assert.ok(matches(rows[1], "amdb") && matches(rows[1], "") && !matches(rows[1], "nvda"));
});

test("stocks: rows rank running, then reviewed with a pool, then the rest; reasons come along", async () => {
  const { groupStocks, hasPool } = await import("./stocks.ts");
  const rows = groupStocks([
    { symbol: "AAPLon", underlying: "AAPL", issuer: "Ondo", token: "0x1", price: 1, logo: "https://x/aapl.png", river: "watching", state: "not_eligible", reason: "no PancakeSwap v3 pool against USDT" },
    { symbol: "CRCLB", underlying: "CRCL", issuer: "bStocks", token: "0x2", price: 1, river: "watching", state: "not_eligible", reason: "net APR -7.2% is below 3%" },
    { symbol: "GOOGLB", underlying: "GOOGL", issuer: "bStocks", token: "0x3", price: 1, river: "watching", state: "reviewing", reason: "queued" },
    { symbol: "NVDAB", underlying: "NVDA", issuer: "bStocks", token: "0x4", price: 1, river: "running", state: "running", reason: null },
  ]);
  assert.deepEqual(rows.map((r) => r.underlying), ["NVDA", "GOOGL", "CRCL", "AAPL"]);
  assert.equal(rows[2].reason, "net APR -7.2% is below 3%");
  assert.deepEqual(rows.map(hasPool), [true, true, true, false]);
  assert.equal(rows[3].logo, "https://x/aapl.png");
  assert.equal(rows[0].logo, null);
});

test("altana: River asks only for the position manager's four calls and weekly caps, BNB always included", async () => {
  const { sessionPermissions, defaultCaps, toBase, expiryFor, FEE_CAP_BNB } = await import("./altana.ts");
  const { PANCAKE_V3_NPM, USDT, ASSETS } = await import("../../../packages/core/src/assets.ts");
  const nvdab = ASSETS[0].token;
  const p = sessionPermissions(nvdab, { stock: 1.25, usd: 300 });
  assert.deepEqual(p.calls.map((c) => [c.to, c.signature]), [
    [PANCAKE_V3_NPM, "0x88316456"], [PANCAKE_V3_NPM, "0x0c49ccbe"], [PANCAKE_V3_NPM, "0xfc6f7865"], [PANCAKE_V3_NPM, "0x42966c68"],
  ]);
  assert.deepEqual(p.spend, [
    { token: nvdab, limit: 1_250_000_000_000_000_000n, period: "week" },
    { token: USDT, limit: 300n * 10n ** 18n, period: "week" },
    { limit: toBase(FEE_CAP_BNB), period: "week" },
  ]);
  assert.deepEqual(sessionPermissions(nvdab, { stock: 0, usd: 50 }).spend.map((x) => ("token" in x ? x.token : "BNB")), [USDT, "BNB"]);
  assert.deepEqual(defaultCaps({ stock: 0.8, usd: 173 }), { stock: 1, usd: 220 });
  assert.equal(toBase(0.1), 100_000_000_000_000_000n);
  assert.equal(expiryFor(3, 0), 90 * 86_400);
});
