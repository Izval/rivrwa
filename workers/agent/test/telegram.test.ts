import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleMessage, escapeHtml } from "../src/telegram.ts";
import type { CycleRecord } from "../../../agent/src/store.ts";

const rec: CycleRecord = {
  asset: "NVDAB", owner: "0xabc", signer: "agentic_wallet", window: "2026-10-02", nftId: "123",
  range: { tickLower: -10, tickUpper: 10, priceLow: 170, priceHigh: 190 }, openedAt: "2026-10-03T01:00:00Z", closedAt: "2026-10-04T22:00:00Z",
  exitReason: "window_closing", entryPrice: 180, exitPrice: 181, deposited: { stock: 1, usd: 180 }, withdrawn: { stock: 0.99, usd: 182 },
  fees: { stock: 0.001, usd: 0.2 }, feesUsd: 0.38, ilUsd: -0.05, riverFeeUsd: 0.27, gasBnb: 0.0004, sharesBefore: 1, sharesAfter: 0.991,
  txs: { add: "0x" + "a".repeat(64), remove: "0x" + "b".repeat(64) },
};

test("telegram: the cycle report shows fees, share change and BscScan links, and skips a missing claim", () => {
  const m = cycleMessage(rec);
  assert.match(m, /River cycle closed · NVDAB<\/b> \(window closing\)/);
  assert.match(m, /Fees earned: <b>\$0\.38<\/b>/);
  assert.match(m, /1\.0000 → 0\.9910 \(-0\.0090\)/);
  assert.match(m, /bscscan\.com\/tx\/0xaaaa/);
  assert.doesNotMatch(m, /claim/);
  assert.match(cycleMessage({ ...rec, txs: { ...rec.txs, claim: "0x" + "c".repeat(64) } }), /claim <a href="https:\/\/bscscan\.com\/tx\/0xcccc/);
});

test("telegram: text is escaped for HTML parse mode", () => {
  assert.equal(escapeHtml("<b>&"), "&lt;b&gt;&amp;");
});
