import { test } from "node:test";
import assert from "node:assert/strict";
import { poolState, erc20Balance, mintedNftId, npmAmounts, gasBnb, waitForReceipt, TOPIC, PANCAKE_V3_NPM, assetBySymbol, type Receipt } from "../src/index.ts";

/** fetch stub: answers each JSON-RPC call with `results[method]` (a value or a function of params). */
const fakeRpc = (results: Record<string, unknown>) =>
  (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    const v = results[method];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: typeof v === "function" ? v(params) : v }));
  }) as typeof fetch;

const w = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const OWNER = "0x00000000000000000000000000000000000000aa";
const topicAddr = (a: string) => "0x" + a.slice(2).padStart(64, "0");

// Live slot0 of the NVDAB/USDT pool on 2026-09-29 (tick 54412, stock is token0).
const SLOT0 = "0x000000000000000000000000000000000000000f3006959bae81117c57b8b3b8" + w(54412n) + w(1289n) + w(3000n).repeat(2) + w(0xc800c8n) + w(1n);

test("bsc: slot0 → stock price in both pool orientations", async () => {
  const fetchImpl = fakeRpc({ eth_call: SLOT0 });
  const nvda = await poolState("0xpool", { stockIsToken0: true, tickSpacing: 50 }, { fetchImpl });
  assert.equal(nvda.tick, 54412);
  assert.ok(Math.abs(nvda.price - Math.pow(1.0001, 54412)) / nvda.price < 1e-4);
  const inverted = await poolState("0xpool", { stockIsToken0: false, tickSpacing: 50 }, { fetchImpl });
  assert.ok(Math.abs(inverted.price * nvda.price - 1) < 1e-9);
  const neg = await poolState("0xpool", { stockIsToken0: true, tickSpacing: 50 }, { fetchImpl: fakeRpc({ eth_call: "0x" + w(1n << 96n) + w(-50n) }) });
  assert.equal(neg.tick, -50);
});

test("bsc: erc20 balance is scaled from 18 decimals", async () => {
  const fetchImpl = fakeRpc({ eth_call: (p: [{ data: string }]) => (assert.ok(p[0].data.endsWith("aa")), "0x" + w(1_500_000_000_000_000_000n)) });
  assert.equal(await erc20Balance("0xtoken", OWNER, { fetchImpl }), 1.5);
});

const receipt: Receipt = {
  transactionHash: "0xabc", status: "0x1", blockNumber: "0x1",
  logs: [
    // ERC20 transfer from the same tx must be ignored (different contract).
    { address: "0x55d398326f99059ff775485246999027b3197955", topics: [TOPIC.transfer, topicAddr(OWNER), topicAddr("0x" + "11".repeat(20))], data: "0x" + w(5n) },
    { address: PANCAKE_V3_NPM, topics: [TOPIC.transfer, "0x" + "0".repeat(64), topicAddr(OWNER), "0x" + w(123456n)], data: "0x" },
    { address: PANCAKE_V3_NPM, topics: [TOPIC.collect, "0x" + w(123456n)], data: "0x" + w(0xaan) + w(2n * 10n ** 17n) + w(3n * 10n ** 18n) },
  ],
};

test("bsc: minted NFT id and collected amounts come from the NPM logs", () => {
  assert.equal(mintedNftId(receipt, OWNER), "123456");
  assert.equal(mintedNftId(receipt, "0x00000000000000000000000000000000000000bb"), null);
  const tsla = assetBySymbol("TSLAB")!; // stock is token1
  assert.deepEqual(npmAmounts(receipt, "collect", "123456", tsla), { stock: 3, usd: 0.2 });
  assert.deepEqual(npmAmounts(receipt, "collect", "999", tsla), { stock: 0, usd: 0 });
  assert.deepEqual(npmAmounts(receipt, "increase", "123456", tsla), { stock: 0, usd: 0 });
  assert.equal(gasBnb({ ...receipt, gasUsed: "0x" + (500_000).toString(16), effectiveGasPrice: "0x" + (1e9).toString(16) }), 0.0005);
});

test("bsc: waitForReceipt polls until mined and rejects reverts", async () => {
  let calls = 0;
  const r = await waitForReceipt("0xabc", { pollMs: 1, fetchImpl: fakeRpc({ eth_getTransactionReceipt: () => (++calls < 3 ? null : receipt) }) });
  assert.equal(r.transactionHash, "0xabc");
  assert.equal(calls, 3);
  await assert.rejects(waitForReceipt("0xabc", { fetchImpl: fakeRpc({ eth_getTransactionReceipt: { ...receipt, status: "0x0" } }) }), /reverted/);
});
