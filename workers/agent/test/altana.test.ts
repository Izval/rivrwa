import { test } from "node:test";
import assert from "node:assert/strict";
import { AltanaSigner, type AltanaBackend } from "../src/altana.ts";
import { ASSETS, PANCAKE_V3_NPM, USDT, decodeMint, encodeCollect, encodeDecrease, NPM_SEL, type Call } from "../../../packages/core/src/index.ts";

const ACCOUNT = "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c";
const NVDAB = ASSETS.find((a) => a.symbol === "NVDAB")!;
const E18 = 10n ** 18n;
const w = (x: bigint | string) => BigInt(x).toString(16).padStart(64, "0");
const mintFor = (recipient: string) => "0x88316456" + [
  NVDAB.token, USDT, 2500n, 54100n, 54550n, E18, 250n * E18, 1n, 1n, recipient, 1_790_809_439n,
].map((x) => w(typeof x === "string" ? BigInt(x) : x)).join("");
const range = { tickLower: 54100, tickUpper: 54550, priceLow: 223, priceHigh: 233 };
const now = Date.parse("2026-10-03T01:10:00Z");

function backend(over: Partial<AltanaBackend> = {}, remove?: () => Promise<unknown>) {
  const sent: Call[][] = [];
  const b: AltanaBackend = {
    account: ACCOUNT, expiry: Math.floor(now / 1000) + 30 * 86_400, revoked: false, now: () => now,
    build: {
      lpAddCalculate: async () => ({ outputs: [{ tokenAddress: NVDAB.token, tokenSymbol: "NVDAB", amount: "1" }, { tokenAddress: USDT, tokenSymbol: "USDT", amount: "250" }], poolInfo: { currentTick: "54347" } }),
      lpAdd: async () => ({ dataList: [
        { callDataType: "APPROVE", to: NVDAB.token, value: "0x0", data: "0x095ea7b3" + w(PANCAKE_V3_NPM) + "f".repeat(64) },
        { callDataType: "LP_ADD", to: PANCAKE_V3_NPM, value: "0x0", data: mintFor(ACCOUNT) },
      ] }),
      lpRemove: remove ?? (async () => { throw new Error("Binance down"); }),
      simulate: async () => ({ status: "SUCCESS", failReason: "", balanceChanges: [{ contractAddress: USDT, tokenType: "Erc20", change: "-1", owner: ACCOUNT }, { contractAddress: USDT, tokenType: "Erc20", change: "1", owner: NVDAB.pool.toLowerCase() }], allowanceChanges: [] }),
    } as unknown as AltanaBackend["build"],
    call: async (_to, data) => {
      if (data.startsWith(NPM_SEL.mint)) return "0x" + w(42n) + w(1000n) + w(8n * E18 / 10n) + w(200n * E18); // uses 0.8 NVDAB + 200 USDT
      if (data.startsWith(NPM_SEL.positions)) return "0x" + [0n, 0n, 0n, 0n, 2500n, 0n, 0n, 5000n, 0n, 0n, 0n, 0n].map(w).join("");
      if (data.startsWith(NPM_SEL.decreaseLiquidity)) return "0x" + w(E18) + w(100n * E18);
      if (data.startsWith(NPM_SEL.collect)) return "0x" + w(E18 / 100n) + w(2n * E18);
      throw new Error("unexpected call " + data.slice(0, 10));
    },
    send: async (calls) => { sent.push(calls); return "0x" + "ab".repeat(32); },
    ...over,
  };
  return { signer: new AltanaSigner(b), sent };
}

test("altana: the session is live until expiry, warns in its last week, and is off once revoked", async () => {
  assert.deepEqual((await backend().signer.session()).warnings, []);
  const soon = await backend({ expiry: Math.floor(now / 1000) + 3 * 86_400 }).signer.session();
  assert.equal(soon.connected, true);
  assert.equal(soon.warnings.length, 1);
  assert.equal((await backend({ revoked: true }).signer.session()).connected, false);
  assert.equal((await backend({ expiry: Math.floor(now / 1000) - 1 }).signer.session()).connected, false);
  await assert.rejects(backend({ revoked: true }).signer.execute({ kind: "claim", asset: NVDAB, nftId: "1" }), /ended or was revoked/);
});

test("altana: add previews what the mint uses and sends only the mint, with River's mins and deadline", async () => {
  const { signer, sent } = backend();
  const op = { kind: "add" as const, asset: NVDAB, range, token: NVDAB.token, amount: 1, slippageBps: 100 };
  const pv = await signer.preview(op);
  assert.deepEqual(pv.balanceChange, [
    { token: NVDAB.token, symbol: "NVDAB", amount: -0.8 },
    { token: USDT, symbol: "USDT", amount: -200 },
  ]);
  assert.equal(await signer.execute(op), "0x" + "ab".repeat(32));
  assert.equal(sent[0].length, 1);
  const m = decodeMint(sent[0][0].data);
  assert.equal(m.amount0Min, (8n * E18 / 10n) * 9900n / 10000n);
  assert.equal(m.amount1Min, 198n * E18);
  assert.equal(m.deadline, Math.floor(now / 1000) + 20 * 60);
  assert.equal(m.recipient, ACCOUNT);
});

test("altana: a builder that mints to someone else, or off the planned ticks, is refused", async () => {
  const lpAdd = async () => ({ dataList: [{ callDataType: "LP_ADD", to: PANCAKE_V3_NPM, value: "0x0", data: mintFor("0x000000000000000000000000000000000000beef") }] });
  const hostile = backend({ build: { ...backend().signer["b"].build, lpAdd } as unknown as AltanaBackend["build"] });
  await assert.rejects(hostile.signer.execute({ kind: "add", asset: NVDAB, range, token: NVDAB.token, amount: 1, slippageBps: 100 }), /mint recipient/);
  assert.equal(hostile.sent.length, 0);
  const { signer } = backend();
  await assert.rejects(signer.preview({ kind: "add", asset: NVDAB, range: { ...range, tickLower: 54000 }, token: NVDAB.token, amount: 1, slippageBps: 100 }), /differ from the plan/);
});

test("altana: claim is River's own collect to the account", async () => {
  const { signer, sent } = backend();
  const pv = await signer.preview({ kind: "claim", asset: NVDAB, nftId: "42" });
  assert.deepEqual(pv.balanceChange.map((b) => b.amount), [0.01, 2]);
  await signer.execute({ kind: "claim", asset: NVDAB, nftId: "42" });
  assert.deepEqual(sent[0], [{ to: PANCAKE_V3_NPM, data: encodeCollect("42", ACCOUNT), value: "0x0" }]);
});

test("altana: remove falls back to decrease + collect when Binance fails, with mins from the live decrease", async () => {
  const { signer, sent } = backend();
  const pv = await signer.preview({ kind: "remove", asset: NVDAB, nftId: "42", slippageBps: 50 });
  assert.match(pv.warnings[0], /Binance down/);
  await signer.execute({ kind: "remove", asset: NVDAB, nftId: "42", slippageBps: 50 });
  const deadline = Math.floor(now / 1000) + 20 * 60;
  assert.deepEqual(sent[0].map((c) => c.data), [
    encodeDecrease("42", 5000n, E18 * 9950n / 10000n, 100n * E18 * 9950n / 10000n, deadline),
    encodeCollect("42", ACCOUNT),
  ]);
});

test("altana: Binance's remove is used when it passes the guard, minus any burn", async () => {
  const dec = encodeDecrease("42", 5000n, 0n, 0n, 1), col = encodeCollect("42", ACCOUNT), burn = NPM_SEL.burn + w(42n);
  const { signer, sent } = backend({}, async () => ({ dataList: [dec, col, burn].map((data) => ({ callDataType: "LP_REMOVE", to: PANCAKE_V3_NPM, value: "0x0", data })) }));
  const pv = await signer.preview({ kind: "remove", asset: NVDAB, nftId: "42", slippageBps: 50 });
  assert.deepEqual(pv.warnings, []);
  await signer.execute({ kind: "remove", asset: NVDAB, nftId: "42", slippageBps: 50 });
  assert.deepEqual(sent[0].map((c) => c.data.slice(0, 10)), [NPM_SEL.decreaseLiquidity, NPM_SEL.collect]);
});

test("altana: an account's keys prove River's session key and the passkey only while they are live", async () => {
  const { keysInclude, newSessionKey } = await import("../src/altana-sdk.ts");
  const k = newSessionKey();
  assert.match(k.address, /^0x[0-9a-f]{40}$/);
  assert.match(k.publicKey, /^0x04[0-9a-f]{128}$/);
  const passkey = "0x" + "12".repeat(64);
  const keys = [
    { expiry: 0, keyType: 1, isSuperAdmin: true, publicKey: passkey },
    { expiry: 2_000_000_000, keyType: 2, isSuperAdmin: false, publicKey: "0x" + k.address.slice(2).padStart(64, "0") },
  ];
  assert.deepEqual(keysInclude(keys, { sessionAddress: k.address, passkeyPubkey: passkey }, 1_800_000_000), { session: true, passkey: true });
  assert.deepEqual(keysInclude(keys, { sessionAddress: k.address, passkeyPubkey: passkey }, 2_100_000_000), { session: false, passkey: true });
  assert.deepEqual(keysInclude(keys, { sessionAddress: "0x" + "9".repeat(40), passkeyPubkey: "0x" + "34".repeat(64) }, 1_800_000_000), { session: false, passkey: false });
});

test("altana: Binance's simulation must show tokens moving only between the account and the pool", async () => {
  const op = { kind: "add" as const, asset: NVDAB, range, token: NVDAB.token, amount: 1, slippageBps: 100 };
  const sim = (r: object) => async () => ({ status: "SUCCESS", failReason: "", balanceChanges: [], allowanceChanges: [], ...r });
  const withSim = (simulate: () => Promise<unknown>) => {
    const { signer, sent } = backend();
    const b = (signer as unknown as { b: AltanaBackend }).b;
    b.build = { ...b.build, simulate } as AltanaBackend["build"];
    return { signer, sent };
  };
  const thief = withSim(sim({ balanceChanges: [{ contractAddress: USDT, tokenType: "Erc20", change: "5", owner: "0x000000000000000000000000000000000000beef" }] }));
  await assert.rejects(thief.signer.execute(op), /neither the account nor the pool/);
  assert.equal(thief.sent.length, 0);
  await assert.rejects(withSim(sim({ allowanceChanges: [{ tokenAddress: USDT, owner: ACCOUNT, spender: "0x000000000000000000000000000000000000beef", preAmount: "0", postAmount: "1" }] })).signer.execute(op), /allowance/);
  await assert.rejects(withSim(sim({ status: "FAILED", failReason: "STF" })).signer.execute(op), /simulation FAILED: STF/);
  // Simulator down: the entry waits, the exit still goes out on the calldata guard.
  const down = async () => { throw new Error("HTTP 503"); };
  await assert.rejects(withSim(down).signer.execute(op), /simulation unavailable, not entering/);
  const exit = withSim(down);
  const pv = await exit.signer.preview({ kind: "remove", asset: NVDAB, nftId: "42", slippageBps: 100 });
  assert.ok(pv.warnings.some((w) => w.includes("simulation unavailable")));
});
