import { test } from "node:test";
import assert from "node:assert/strict";
import { challenge, readSignature, checkTransfer, encodeHeader, type Requirement } from "../src/x402.ts";
import type { B402Kind } from "../src/binance.ts";
import { USDT } from "../src/assets.ts";

const PAY_TO = "0x00000000000000000000000000000000000a11ce";
const KINDS: B402Kind[] = [
  { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", signerAddress: "0x1111111111111111111111111111111111111111", spenderAddress: "0x2222222222222222222222222222222222222222" } },
  { x402Version: 2, scheme: "exact", network: "eip155:56", extra: { name: "United Stables", version: "1", assetTransferMethod: "eip3009", signerAddress: "0x1111111111111111111111111111111111111111" } },
  { x402Version: 2, scheme: "exact", network: "eip155:1", extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", signerAddress: "0x1", spenderAddress: "0x2" } },
];
const base = { usd: 0.1, payTo: PAY_TO, url: "https://api.rivrwa.com/v1/paid/plan", description: "plan" };

test("x402: the transfer rail is always offered; b402 only for kinds Binance supports", () => {
  assert.deepEqual(challenge(base).accepts.map((a) => a.extra.assetTransferMethod), ["transfer"]);
  const c = challenge({ ...base, kinds: KINDS });
  assert.deepEqual(c.accepts.map((a) => a.extra.assetTransferMethod), ["permit2-exact", "eip3009", "transfer"]);
  assert.equal(c.accepts[0].amount, "100000000000000000"); // $0.10 in 18 dp
  assert.equal(c.accepts[0].asset, USDT);
});

test("x402: a b402 signature must accept one of our requirements exactly", () => {
  const c = challenge({ ...base, kinds: KINDS });
  const pay = (accepted: Requirement) => encodeHeader({ x402Version: 2, resource: c.resource, accepted, payload: { signature: "0xsig" } });
  const ok = readSignature(pay(c.accepts[0]), c);
  assert.ok(ok.ok && ok.requirement.asset === USDT);
  assert.equal(readSignature(pay({ ...c.accepts[0], amount: "1" }), c).ok, false);
  assert.equal(readSignature(pay({ ...c.accepts[0], payTo: "0x000000000000000000000000000000000000beef" }), c).ok, false);
  assert.equal(readSignature(pay(c.accepts[2]), c).ok, false, "the transfer rail cannot be claimed with a signature");
  assert.equal(readSignature("not base64 json", c).ok, false);
});

test("x402: transfer proof needs a USDT Transfer to payTo of at least the price", () => {
  const c = challenge(base);
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const from = "0x" + "ab".repeat(20).padStart(64, "0"), to = "0x" + PAY_TO.slice(2).padStart(64, "0");
  const rec = (value: bigint, token = USDT, status = "0x1") => ({
    transactionHash: "0x1", status, blockNumber: "0x1",
    logs: [{ address: token, topics: [T, from, to], data: "0x" + value.toString(16).padStart(64, "0") }],
  });
  const ok = checkTransfer(rec(10n ** 17n), c);
  assert.ok(ok.ok && ok.from === "0x" + "ab".repeat(20));
  assert.equal(checkTransfer(rec(10n ** 17n - 1n), c).ok, false);
  assert.equal(checkTransfer(rec(10n ** 17n, "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"), c).ok, false);
  assert.equal(checkTransfer(rec(10n ** 17n, USDT, "0x0"), c).ok, false);
  assert.equal(checkTransfer(null, c).ok, false);
});
