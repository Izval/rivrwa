import { test } from "node:test";
import assert from "node:assert/strict";
import {
  npmGuard, decodeMint, withMintMins, unwrapMulticall, encodeCollect, encodeDecrease, encodeBurn, mintResult, positionResult,
  GuardError, NPM_SEL, type BuiltTx,
} from "../src/npm.ts";
import { PANCAKE_V3_NPM } from "../src/assets.ts";

// Real output of Binance's lp-add (2026-09-30) for NVDAB/USDT, 1 NVDAB + 250 USDT, ticks 54100..54550, address = ACCOUNT.
const ACCOUNT = "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c";
const MAX = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const APPROVE_NPM = `0x095ea7b3${PANCAKE_V3_NPM.slice(2).padStart(64, "0")}${MAX}`;
const MINT = "0x88316456" + [
  "02fca66c1d1afb4e2a7884261eb00f63598a7436", "55d398326f99059ff775485246999027b3197955", "9c4", "d354", "d516",
  "de0b6b3a7640000", "d8d726b7177a80000", "949ecca08449eda", "acc95ba613642692c", ACCOUNT.slice(2), "6abd955f",
].map((w) => w.padStart(64, "0")).join("");
const LP_ADD: BuiltTx[] = [
  { callDataType: "APPROVE", to: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", value: "0x0", data: APPROVE_NPM },
  { callDataType: "APPROVE", to: "0x55d398326f99059fF775485246999027B3197955", value: "0x0", data: APPROVE_NPM },
  { callDataType: "LP_ADD", to: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364", value: "0x0", data: MINT },
];
const hostile = "0x000000000000000000000000000000000000beef";

/** multicall(bytes[]) encoder, for the tests only. */
function multicall(calls: string[]): string {
  const bodies = calls.map((c) => c.slice(2));
  const w = (n: number) => n.toString(16).padStart(64, "0");
  let offs = "", tail = "", at = calls.length * 32;
  for (const b of bodies) {
    const len = b.length / 2, padded = b.padEnd(Math.ceil(len / 32) * 64, "0");
    offs += w(at); tail += w(len) + padded; at += 32 + padded.length / 2;
  }
  return NPM_SEL.multicall + w(32) + w(calls.length) + offs + tail;
}

test("npm: Binance's lp-add passes the guard as a single mint, approvals dropped", () => {
  const calls = npmGuard(LP_ADD, ACCOUNT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, PANCAKE_V3_NPM);
  const m = decodeMint(calls[0].data);
  assert.equal(m.recipient, ACCOUNT);
  assert.deepEqual([m.fee, m.tickLower, m.tickUpper], [2500, 54100, 54550]);
  assert.equal(m.amount0Desired, 10n ** 18n);
  assert.equal(m.amount1Desired, 250n * 10n ** 18n);
});

test("npm: negative ticks decode (TSLAB's pool sits below tick 0)", () => {
  const neg = MINT.slice(0, 10 + 3 * 64) + "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff19ba" + MINT.slice(10 + 4 * 64);
  assert.equal(decodeMint(neg).tickLower, -58950);
});

test("npm: the guard refuses a foreign recipient, target, selector or value", () => {
  const theirs = MINT.slice(0, 10 + 9 * 64) + hostile.slice(2).padStart(64, "0") + MINT.slice(10 + 10 * 64);
  assert.throws(() => npmGuard([{ to: PANCAKE_V3_NPM, data: theirs }], ACCOUNT), /mint recipient/);
  assert.throws(() => npmGuard([{ to: hostile, data: MINT }], ACCOUNT), /not the position manager/);
  assert.throws(() => npmGuard([{ to: PANCAKE_V3_NPM, data: "0x12345678" + "00".repeat(32) }], ACCOUNT), /selector 0x12345678/);
  assert.throws(() => npmGuard([{ to: PANCAKE_V3_NPM, data: MINT, value: "0x1" }], ACCOUNT), /value/);
  assert.throws(() => npmGuard([{ to: PANCAKE_V3_NPM, data: encodeCollect(7n, hostile) }], ACCOUNT), /collect recipient/);
  assert.throws(() => npmGuard([LP_ADD[0]], ACCOUNT), GuardError); // only approvals: nothing to sign
});

test("npm: a remove multicall is flattened into decrease, collect and burn; a hostile collect inside it is caught", () => {
  const dec = encodeDecrease(7n, 1000n, 1n, 2n, 1_800_000_000), col = encodeCollect(7n, ACCOUNT), burn = encodeBurn(7n);
  assert.deepEqual(unwrapMulticall(multicall([dec, col, burn])), [dec, col, burn]);
  const calls = npmGuard([{ callDataType: "LP_REMOVE", to: PANCAKE_V3_NPM, data: multicall([dec, col, burn]) }], ACCOUNT);
  assert.deepEqual(calls.map((c) => c.data.slice(0, 10)), [NPM_SEL.decreaseLiquidity, NPM_SEL.collect, NPM_SEL.burn]);
  assert.throws(() => npmGuard([{ to: PANCAKE_V3_NPM, data: multicall([dec, encodeCollect(7n, hostile)]) }], ACCOUNT), /collect recipient/);
});

test("npm: River's mins replace Binance's, the rest of the mint is untouched", () => {
  const out = withMintMins(MINT, 5n, 6n, 1_900_000_000);
  const a = decodeMint(MINT), b = decodeMint(out);
  assert.deepEqual([b.amount0Min, b.amount1Min, b.deadline], [5n, 6n, 1_900_000_000]);
  assert.deepEqual({ ...b, amount0Min: 0n, amount1Min: 0n, deadline: 0 }, { ...a, amount0Min: 0n, amount1Min: 0n, deadline: 0 });
  assert.equal(out.length, MINT.length);
});

test("npm: return decoders read mint and positions words", () => {
  const w = (x: bigint) => x.toString(16).padStart(64, "0");
  assert.deepEqual(mintResult("0x" + w(9n) + w(100n) + w(3n) + w(4n)), { tokenId: 9n, liquidity: 100n, amount0: 3n, amount1: 4n });
  const pos = "0x" + [0n, 0n, 1n, 2n, 2500n, 0n, 0n, 777n, 0n, 0n, 11n, 12n].map(w).join("");
  assert.deepEqual(positionResult(pos), { token0: "0x" + "1".padStart(40, "0"), token1: "0x" + "2".padStart(40, "0"), fee: 2500, liquidity: 777n, tokensOwed0: 11n, tokensOwed1: 12n });
});
