import { test } from "node:test";
import assert from "node:assert/strict";
import { assetBySymbol, fillGaps, RIVER_FEE, TOPIC, PANCAKE_V3_NPM, USDT, type Candle, type Receipt } from "../../packages/core/src/index.ts";
import { tick, type Deps, type RunConfig } from "../src/runner.ts";
import { memoryStore, type AgentState } from "../src/store.ts";
import type { LpOp, Preview, Session, Signer } from "../src/signer.ts";

const OWNER = "0x00000000000000000000000000000000000000aa";
const nvda = assetBySymbol("NVDAB")!; // stock is token0
const t = (s: string) => Date.parse(s);

// Synthetic hourly series (same shape as the core tests): weekends oscillate ±0.8% around 230.
function series(fromIso: string, hours: number): Candle[] {
  const t0 = t(fromIso) / 1000;
  return fillGaps(Array.from({ length: hours }, (_, i) => {
    const ts = t0 + i * 3600;
    const dow = new Date(ts * 1000).getUTCDay();
    const c = dow === 0 || dow === 6 ? 230 * (1 + 0.008 * Math.sin(i / 3)) : 230 * (1 + 0.0004 * (i % 48));
    return { ts, o: c, h: c * 1.001, l: c * 0.999, c, vol: 50_000 };
  }), 3600);
}
const CANDLES = series("2026-08-24T00:00:00Z", 24 * 45);

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const wei = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const npmLog = (topic: string, nftId: number, a0: number, a1: number) =>
  ({ address: PANCAKE_V3_NPM, topics: [topic, "0x" + w(BigInt(nftId))], data: "0x" + w(1n) + w(wei(a0)) + w(wei(a1)) });

/** A fake chain + Agentic Wallet: every executed op gets a receipt with the NPM logs a real one would carry. */
function world(o: { usdPerStock?: number; mintTo?: string; mined?: boolean; session?: Partial<Session> } = {}) {
  const ops: string[] = [];
  const receipts = new Map<string, Receipt>();
  let n = 0;
  const chain = { mined: o.mined ?? true };
  const receipt = (hash: string, logs: Receipt["logs"], status = "0x1"): Receipt =>
    ({ transactionHash: hash, status, blockNumber: "0x1", gasUsed: "0x" + (300_000).toString(16), effectiveGasPrice: "0x" + (1e8).toString(16), logs });
  const signer: Signer = {
    kind: "agentic_wallet",
    address: async () => OWNER,
    session: async () => ({ connected: true, expiresAt: Infinity, warnings: [], ...o.session }),
    preview: async (op: LpOp): Promise<Preview> => {
      ops.push(`preview:${op.kind}`);
      const bc = op.kind === "add" ? [{ token: nvda.token, symbol: "NVDAB", amount: -op.amount }, { token: USDT, symbol: "USDT", amount: -op.amount * (o.usdPerStock ?? 100) }] : [];
      return { balanceChange: bc, warnings: [], raw: null };
    },
    execute: async (op: LpOp) => {
      ops.push(op.kind);
      const hash = `0x${op.kind}${++n}`;
      if (op.kind === "add") {
        const to = o.mintTo ?? OWNER;
        receipts.set(hash, receipt(hash, [
          { address: PANCAKE_V3_NPM, topics: [TOPIC.transfer, "0x" + w(0n), "0x" + to.slice(2).padStart(64, "0"), "0x" + w(4242n)], data: "0x" },
          npmLog(TOPIC.increase, 4242, op.amount, op.amount * (o.usdPerStock ?? 100)),
        ]));
      } else if (op.kind === "claim") {
        receipts.set(hash, receipt(hash, [npmLog(TOPIC.collect, 4242, 0.01, 3)]));
      } else {
        receipts.set(hash, receipt(hash, [npmLog(TOPIC.decrease, 4242, 5, 900), npmLog(TOPIC.collect, 4242, 5, 900.5)]));
      }
      return hash;
    },
  };
  return { ops, receipts, chain, signer };
}

function setup(o: Parameters<typeof world>[0] & { state?: AgentState; mode?: RunConfig["mode"]; price?: number } = {}) {
  const wd = world(o);
  const store = memoryStore(o.state);
  const clock = { now: t("2026-09-30T15:00:00Z"), price: o.price ?? 230 };
  const logs: string[] = [];
  const deps: Deps = {
    signer: wd.signer, store, now: () => clock.now, log: (l) => logs.push(l), sleep: async () => {},
    candles: async () => CANDLES.filter((c) => c.ts * 1000 <= clock.now),
    pool: async () => ({ price: clock.price, tick: 0 }),
    balance: async (token) => (token === nvda.token ? 20 : 3000),
    receipt: async (h) => (wd.chain.mined ? wd.receipts.get(h) ?? null : null),
  };
  const cfg: RunConfig = {
    asset: nvda,
    mode: o.mode ?? "live", slippageBps: 100, events: [], signer: "agentic_wallet", receiptTimeoutMs: 6000,
    mandate: { owner: OWNER, asset: "NVDAB", allocation: 0.5, maxHalfWidth: 0.05, exitOnDrift: 0.03, skipEvents: true, restoreShares: false, expiresAt: t("2026-12-31T00:00:00Z") },
  };
  return { ...wd, store, clock, logs, deps, cfg, run: () => tick(cfg, deps) };
}

test("runner: waits on weekdays, enters Saturday, holds, exits Sunday and records the cycle", async () => {
  const x = setup();
  assert.equal((await x.run()).kind, "wait");

  x.clock.now = t("2026-10-03T01:30:00Z");
  const e = await x.run();
  assert.equal(e.kind, "entered", e.note);
  assert.deepEqual(x.ops, ["preview:add", "add"]);
  const pos = x.store.state.position!;
  assert.equal(pos.nftId, "4242");
  assert.ok(pos.entryAmounts.stock > 0 && pos.entryAmounts.stock <= 10); // 50% of 20 shares
  assert.equal(pos.windowEnd, t("2026-10-04T22:00:00Z"));
  assert.equal(pos.entry.inventoryBefore.stock, 20);

  x.clock.now = t("2026-10-03T12:00:00Z");
  assert.equal((await x.run()).kind, "hold");

  x.clock.now = t("2026-10-04T22:05:00Z");
  x.clock.price = 231;
  const out = await x.run();
  assert.equal(out.kind, "exited", out.note);
  assert.deepEqual(x.ops.slice(2), ["preview:claim", "claim", "preview:remove", "remove"]);
  assert.equal(x.store.state.position, null);
  const c = x.store.cycles[0];
  assert.equal(c.exitReason, "window_closing");
  assert.deepEqual(c.fees, { stock: 0.01, usd: 3.5 }); // claim + what remove paid beyond the principal
  assert.ok(Math.abs(c.feesUsd - (0.01 * 231 + 3.5)) < 1e-9);
  assert.ok(Math.abs(c.riverFeeUsd - (c.feesUsd * RIVER_FEE.share + RIVER_FEE.fixedUsd)) < 1e-9);
  assert.deepEqual(c.txs, { add: "0xadd1", claim: "0xclaim2", remove: "0xremove3" });
  assert.ok(c.gasBnb > 0);
});

test("runner: a tx not mined in this tick is settled by the next one, never sent twice", async () => {
  const x = setup({ mined: false });
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "pending");
  assert.equal(x.store.state.pending?.kind, "add");
  assert.equal((await x.run()).kind, "pending");
  assert.deepEqual(x.ops, ["preview:add", "add"]);
  x.chain.mined = true;
  x.clock.now = t("2026-10-03T01:40:00Z");
  assert.equal((await x.run()).kind, "hold");
  assert.equal(x.store.state.position?.nftId, "4242");
  assert.deepEqual(x.ops, ["preview:add", "add"]);
});

test("runner: the window closes early when the signer's session would expire", async () => {
  const x = setup({ session: { expiresAt: t("2026-10-03T12:00:00Z") } });
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "entered");
  assert.equal(x.store.state.position!.windowEnd, t("2026-10-03T11:30:00Z"));
  x.clock.now = t("2026-10-03T11:35:00Z");
  assert.equal((await x.run()).kind, "exited");

  const short = setup({ session: { expiresAt: t("2026-10-03T05:00:00Z") } });
  short.clock.now = t("2026-10-03T01:30:00Z");
  const r = await short.run();
  assert.equal(r.kind, "skip");
  assert.match(r.note, /too little of the window/);
});

test("runner: drift exit, and exits on the clock even when the signal source is down", async () => {
  const x = setup();
  x.clock.now = t("2026-10-03T01:30:00Z");
  await x.run();
  x.clock.now = t("2026-10-03T06:00:00Z");
  x.clock.price = 230 * 1.04;
  const d = await x.run();
  assert.equal(d.kind, "exited");
  assert.equal(x.store.cycles[0].exitReason, "drift");

  const y = setup();
  y.clock.now = t("2026-10-03T01:30:00Z");
  await y.run();
  y.deps.candles = async () => { throw new Error("geckoterminal 429"); };
  y.clock.now = t("2026-10-03T06:00:00Z");
  assert.equal((await y.run()).kind, "hold");
  y.clock.now = t("2026-10-04T22:01:00Z");
  assert.equal((await y.run()).kind, "exited");
  assert.ok(y.logs.some((l) => /signal unavailable/.test(l)));
});

test("runner: dry-run previews without sending or saving; status does neither", async () => {
  const x = setup({ mode: "dry-run" });
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "previewed");
  assert.deepEqual(x.ops, ["preview:add"]);
  assert.equal(x.store.state.pending, null);
  const s = setup({ mode: "status" });
  s.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await s.run()).kind, "enter");
  assert.deepEqual(s.ops, []);
});

test("runner: shrinks the deposit when the live tick asks for more USDT than allocated", async () => {
  const x = setup({ usdPerStock: 400 }); // 10 shares would need $4000 > $1500 allocated
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "entered");
  assert.deepEqual(x.ops, ["preview:add", "preview:add", "add"]);
  assert.ok(x.store.state.position!.entryAmounts.usd <= 1500);
});

test("runner: halts when a mined lp-add minted no NFT to the owner, and refuses a foreign signer", async () => {
  const x = setup({ mintTo: "0x00000000000000000000000000000000000000bb" });
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "halted");
  assert.equal((await x.run()).kind, "halted");
  assert.deepEqual(x.ops, ["preview:add", "add"]);

  const y = setup();
  y.cfg.mandate.owner = "0x00000000000000000000000000000000000000cc";
  assert.equal((await y.run()).kind, "blocked");
});

test("runner: a mandate ending inside the window enters and then leaves at its end (an early exit)", async () => {
  const x = setup();
  x.cfg.mandate = { ...x.cfg.mandate, expiresAt: t("2026-10-10T10:30:00Z") };
  x.clock.now = t("2026-10-10T01:05:00Z");
  assert.equal((await x.run()).kind, "entered");
  x.clock.now = t("2026-10-10T10:00:00Z");
  assert.equal((await x.run()).kind, "hold");
  x.clock.now = t("2026-10-10T10:30:00Z");
  const out = await x.run();
  assert.equal(out.kind, "exited", out.note);
  assert.equal(x.store.cycles[0].exitReason, "mandate_expired");
});

test("runner: an exit marked by hand (Leave the pool now) is carried out on the next tick", async () => {
  const x = setup();
  x.clock.now = t("2026-10-03T01:30:00Z");
  assert.equal((await x.run()).kind, "entered");
  x.store.state.exit = { reason: "manual", startedAt: x.clock.now, gasBnb: 0 };
  x.clock.now = t("2026-10-03T02:00:00Z");
  const out = await x.run();
  assert.equal(out.kind, "exited", out.note);
  assert.equal(x.store.cycles[0].exitReason, "manual");
});
