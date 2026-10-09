import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightChecks, nextWindow, type PreflightFacts } from "../src/preflight.ts";

const H = 3_600_000;
// Wed 30 Sep 2026 12:00 UTC: the next window opens Fri 2 Oct 20:00 ET.
const now = Date.parse("2026-09-30T12:00:00Z");
const { entryAt, exitAt } = nextWindow(now);

const facts = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  now, entryAt, exitAt,
  session: { connected: true, expiresAt: exitAt + 24 * H, warnings: [] },
  asset: { symbol: "NVDAB", enabled: true }, status: "active", allocation: 0.5, mandateExpiresAt: exitAt + 30 * 24 * H,
  state: { halted: null, position: null }, stock: 1, usd: 200, price: 180, bnb: 0.01, telegram: true,
  rehearsal: { at: now - H, kind: "previewed", note: "enter ±2.1%" }, ...over,
});
const level = (f: PreflightFacts, id: string) => preflightChecks(f).items.find((i) => i.id === id)?.level;

test("preflight: the next window is Fri 2 Oct after the close, entry +1h, exit -2h before Monday's reopen", () => {
  assert.equal(new Date(entryAt).toISOString(), "2026-10-03T01:00:00.000Z");
  assert.equal(new Date(exitAt).toISOString(), "2026-10-04T22:00:00.000Z");
});

test("preflight: a funded, active, rehearsed mandate is ready", () => {
  const p = preflightChecks(facts());
  assert.equal(p.ready, true);
  assert.ok(p.items.every((i) => i.level === "ok"), JSON.stringify(p.items.filter((i) => i.level !== "ok")));
});

test("preflight: a session that ends before the exit warns, one that ends near the entry fails", () => {
  assert.equal(level(facts({ session: { connected: true, expiresAt: exitAt - 10 * H, warnings: [] } }), "session"), "warn");
  assert.equal(level(facts({ session: { connected: true, expiresAt: entryAt + H, warnings: [] } }), "session"), "fail");
  assert.equal(preflightChecks(facts({ session: { connected: false, expiresAt: 0, warnings: [] } })).ready, false);
});

test("preflight: funds, gas, expiry and halts block; one-sided funds, pause, no Telegram and no rehearsal only warn", () => {
  assert.equal(level(facts({ stock: 0, usd: 0.5 }), "funds"), "fail");
  assert.equal(level(facts({ stock: 0 }), "funds"), "warn");
  assert.equal(level(facts({ bnb: 0.001 }), "gas"), "fail");
  assert.equal(level(facts({ mandateExpiresAt: exitAt - H }), "expiry"), "warn", "ending inside the window is an early exit");
  assert.equal(level(facts({ mandateExpiresAt: entryAt + 9.5 * H }), "expiry"), "warn", "10 Oct: enter 01:00, leave 10:30 UTC");
  assert.equal(level(facts({ mandateExpiresAt: entryAt + H }), "expiry"), "fail");
  assert.equal(preflightChecks(facts({ state: { halted: "no NFT minted", position: null } })).ready, false);
  const soft = preflightChecks(facts({ status: "paused", telegram: false, rehearsal: null, stock: 0 }));
  assert.equal(soft.ready, true);
  assert.deepEqual(soft.items.filter((i) => i.level === "warn").map((i) => i.id).sort(), ["funds", "rehearsal", "status", "telegram"]);
});

test("preflight: a failed or stale rehearsal is reported", () => {
  assert.equal(level(facts({ rehearsal: { at: now - H, kind: "blocked", note: "error: insufficient balance" } }), "rehearsal"), "fail");
  assert.equal(level(facts({ rehearsal: { at: now - 48 * H, kind: "previewed", note: "ok" } }), "rehearsal"), "warn");
});
