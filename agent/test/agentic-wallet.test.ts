import { test } from "node:test";
import assert from "node:assert/strict";
import { assetBySymbol, snapRange } from "../../packages/core/src/index.ts";
import { AgenticWalletSigner, BawError, formatAmount } from "../src/agentic-wallet.ts";
import { parseMandate, type MandateFile } from "../src/mandate.ts";

/** A fake `baw`: answers by "<group> <command>" and records every argv. */
function fakeBaw(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = args[0] === "defi" && args[1] === "preview" ? `preview ${args[3]}` : `${args[0]} ${args[1]}`;
    const a = answers[key];
    if (a === undefined) throw new Error(`unexpected baw ${key}`);
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { calls, run };
}
const ok = (data: unknown) => ({ success: true, data });
const nvda = assetBySymbol("NVDAB")!;
const range = snapRange(225, 235, nvda);

test("baw: address is the BSC entry, lowercased", async () => {
  const b = fakeBaw({ "wallet address": ok({ addresses: [{ binanceChainId: "CT_501", address: "Sol" }, { binanceChainId: "56", address: "0xAbC0000000000000000000000000000000000001" }] }) });
  assert.equal(await new AgenticWalletSigner(b.run).address(), "0xabc0000000000000000000000000000000000001");
});

test("baw: session ends at the sign-in hard cap, idle sign-out reported, risky settings flagged", async () => {
  const b = fakeBaw({
    "wallet status": ok({ status: "CONNECTED" }),
    "wallet settings": ok({
      sessionExpireTime: "2026-10-05T06:32:05+08:00", inactiveSignOutTime: "2026-10-04T22:00:00Z", signInMaxTime: "2026-10-06T18:58:55+00:00",
      abnormalTxnHandling: "NeedConfirmation", tradeAllTokens: false, defiQuotaLeft: 5000,
    }),
  });
  const s = await new AgenticWalletSigner(b.run).session();
  assert.equal(s.connected, true);
  assert.equal(s.expiresAt, Date.parse("2026-10-06T18:58:55Z")); // the hard cap; activity keeps idle sign-out away
  assert.equal(s.idleExpiresAt, Date.parse("2026-10-04T22:00:00Z"));
  assert.equal(s.quotaUsd, 5000);
  assert.equal(s.warnings.length, 2);
  const off = await new AgenticWalletSigner(fakeBaw({ "wallet status": ok({ status: "UNCONNECTED" }) }).run).session();
  assert.equal(off.connected, false);
});

test("baw: lp-add passes the stock leg with explicit ticks; claim and remove target the NFT", async () => {
  const b = fakeBaw({
    "defi lp-add": ok({ txHash: "0xadd" }), "defi claim": ok({ txHash: "0xclaim" }), "defi lp-remove": ok({ txHash: "0xrm" }),
    "preview LP-ADD": ok({ balanceChange: [{ tokenAddress: "0x55D398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", amount: "-120.5" }], warnings: ["w1"] }),
  });
  const w = new AgenticWalletSigner(b.run);
  const add = { kind: "add" as const, asset: nvda, range, token: nvda.token, amount: 1.234567891234, slippageBps: 100 };
  assert.equal(await w.execute(add), "0xadd");
  assert.deepEqual(b.calls[0], ["defi", "lp-add", "--investmentId", nvda.investmentId, "--tokenAddress", nvda.token, "--amount", "1.23456789",
    "--tickLower", String(range.tickLower), "--tickUpper", String(range.tickUpper), "--slippageBps", "100", "--json"]);
  const pv = await w.preview(add);
  assert.deepEqual(pv.balanceChange, [{ token: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", amount: -120.5 }]);
  assert.deepEqual(pv.warnings, ["w1"]);
  assert.deepEqual(b.calls[1].slice(0, 4), ["defi", "preview", "--action", "LP-ADD"]);
  await w.execute({ kind: "claim", asset: nvda, nftId: "77" });
  assert.ok(b.calls[2].join(" ").includes("--claimType LP_FEE --investmentId " + nvda.investmentId + " --nftId 77 --binanceChainId 56"));
  await w.execute({ kind: "remove", asset: nvda, nftId: "77", slippageBps: 100 });
  assert.ok(b.calls[3].join(" ").includes("--nftId 77 --ratio 1") && !b.calls[3].includes("--binanceChainId"));
});

test("baw: an error envelope becomes a BawError; non-JSON output too", async () => {
  const b = fakeBaw({ "defi lp-add": { success: false, error: { code: 40484, name: "INSUFFICIENT_BALANCE", message: "Insufficient balance" } }, "wallet address": "Segmentation fault" });
  const w = new AgenticWalletSigner(b.run);
  await assert.rejects(w.execute({ kind: "add", asset: nvda, range, token: nvda.token, amount: 1, slippageBps: 100 }),
    (e: unknown) => e instanceof BawError && e.code === "40484" && /Insufficient balance/.test(e.message));
  await assert.rejects(w.address(), /non-JSON/);
});

test("baw: amounts are rounded down, never up", () => {
  assert.equal(formatAmount(1.999999999), "1.99999999");
  assert.equal(formatAmount(2), "2");
  assert.equal(formatAmount(0.1 + 0.2), "0.3");
});

test("mandate: validates and normalises the file", () => {
  const f: MandateFile = {
    owner: "0xAbC0000000000000000000000000000000000001", asset: "nvdab", signer: "agentic_wallet", allocation: 1,
    maxHalfWidth: 0.05, exitOnDrift: 0.03, skipEvents: true, events: ["2026-11-18T21:00:00Z"], restoreShares: false, expiresAt: "2026-12-31T00:00:00Z",
  };
  const m = parseMandate(f);
  assert.equal(m.mandate.owner, "0xabc0000000000000000000000000000000000001");
  assert.equal(m.mandate.asset, "NVDAB");
  assert.equal(m.slippageBps, 100);
  assert.deepEqual(m.events, [Date.parse("2026-11-18T21:00:00Z")]);
  assert.throws(() => parseMandate({ ...f, allocation: 1.5 }), /allocation/);
  assert.throws(() => parseMandate({ ...f, asset: "AAPLB" }), /unknown asset/);
});
