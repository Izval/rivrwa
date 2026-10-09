// npm.ts — PancakeSwap v3 NonfungiblePositionManager calldata: a guard for what Binance's DeFi builders return,
// and the few encoders River needs itself.
//
// Flow B signs with an Altana session key held by River's server. Altana scopes a session by target and selector
// only, so a `mint` or `collect` with someone else's `recipient` would pass its checks. River therefore inspects
// every call before it signs: only the NPM, only mint / decreaseLiquidity / collect / burn, no value, and the
// recipient must be the account itself. Approvals are dropped (the account approved the NPM once, with its
// passkey) and `multicall` is unwrapped, because the session does not allow it.
//
// Binance's `slippageBps` produces mins far looser than asked, and they are relative to the amounts the mint will
// actually use (not the desired ones). So River sets the mint's mins itself from a fresh `eth_call` of the mint
// (`mintResult`) just before it signs (`withMintMins`).

import { PANCAKE_V3_NPM } from "./assets.ts";

export interface Call { to: string; data: string; value?: string }
/** What the Binance builders return per step (`TxRequest` in binance.ts). */
export interface BuiltTx { callDataType?: string; to: string; data: string; value?: string }

export const NPM_SEL = {
  mint: "0x88316456",
  decreaseLiquidity: "0x0c49ccbe",
  collect: "0xfc6f7865",
  burn: "0x42966c68",
  positions: "0x99fbab88",
  multicall: "0xac9650d8", // multicall(bytes[])
  multicallDeadline: "0x5ae401dc", // multicall(uint256,bytes[])
} as const;
const APPROVE = "0x095ea7b3";
const ALLOWED = new Set<string>([NPM_SEL.mint, NPM_SEL.decreaseLiquidity, NPM_SEL.collect, NPM_SEL.burn]);
const UINT128_MAX = (1n << 128n) - 1n;

const body = (data: string) => data.toLowerCase().replace(/^0x/, "");
const sel = (data: string) => "0x" + body(data).slice(0, 8);
/** i-th 32-byte word after the selector. */
const arg = (data: string, i: number) => BigInt("0x" + body(data).slice(8 + i * 64, 8 + (i + 1) * 64));
const hex32 = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const addr = (w: bigint) => "0x" + w.toString(16).padStart(40, "0");

/** The inner calls of `multicall(bytes[])` or `multicall(uint256,bytes[])`. */
export function unwrapMulticall(data: string): string[] {
  const b = body(data).slice(8);
  const at = (byte: number) => BigInt("0x" + b.slice(byte * 2, byte * 2 + 64));
  const head = sel(data) === NPM_SEL.multicallDeadline ? 32 : 0;
  const arr = Number(at(head));
  const n = Number(at(arr));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const off = arr + 32 + Number(at(arr + 32 + i * 32));
    const len = Number(at(off));
    out.push("0x" + b.slice((off + 32) * 2, (off + 32 + len) * 2));
  }
  return out;
}

export class GuardError extends Error {}

/**
 * The NPM calls River may sign for `account`, in order, or a GuardError naming the first thing that is not
 * allowed. Approvals are dropped; multicalls are flattened.
 */
export function npmGuard(txs: readonly BuiltTx[], account: string, npm = PANCAKE_V3_NPM): Call[] {
  const me = account.toLowerCase();
  const out: Call[] = [];
  for (const t of txs) {
    if (t.callDataType === "APPROVE" || sel(t.data) === APPROVE) continue;
    if (t.to.toLowerCase() !== npm) throw new GuardError(`call to ${t.to}, not the position manager`);
    if (t.value && BigInt(t.value) !== 0n) throw new GuardError(`call carries value ${t.value}`);
    const inner = sel(t.data) === NPM_SEL.multicall || sel(t.data) === NPM_SEL.multicallDeadline ? unwrapMulticall(t.data) : [t.data];
    for (const data of inner) {
      const s = sel(data);
      if (!ALLOWED.has(s)) throw new GuardError(`selector ${s} is not allowed`);
      if (s === NPM_SEL.mint && addr(arg(data, 9)) !== me) throw new GuardError(`mint recipient ${addr(arg(data, 9))} is not the account`);
      if (s === NPM_SEL.collect && addr(arg(data, 1)) !== me) throw new GuardError(`collect recipient ${addr(arg(data, 1))} is not the account`);
      out.push({ to: npm, data: "0x" + body(data), value: "0x0" });
    }
  }
  if (out.length === 0) throw new GuardError("nothing to sign");
  return out;
}

export interface MintParams {
  token0: string; token1: string; fee: number; tickLower: number; tickUpper: number;
  amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; recipient: string; deadline: number;
}

export function decodeMint(data: string): MintParams {
  if (sel(data) !== NPM_SEL.mint) throw new GuardError("not a mint");
  const w = (i: number) => arg(data, i);
  return {
    token0: addr(w(0)), token1: addr(w(1)), fee: Number(w(2)),
    tickLower: Number(BigInt.asIntN(24, w(3))), tickUpper: Number(BigInt.asIntN(24, w(4))),
    amount0Desired: w(5), amount1Desired: w(6), amount0Min: w(7), amount1Min: w(8), recipient: addr(w(9)), deadline: Number(w(10)),
  };
}

/** The same mint with River's own minimums (and optionally a new deadline, unix seconds). */
export function withMintMins(data: string, min0: bigint, min1: bigint, deadline?: number): string {
  const b = body(data);
  const words = Array.from({ length: 11 }, (_, i) => b.slice(8 + i * 64, 8 + (i + 1) * 64));
  words[7] = hex32(min0);
  words[8] = hex32(min1);
  if (deadline !== undefined) words[10] = hex32(BigInt(deadline));
  return "0x" + b.slice(0, 8) + words.join("") + b.slice(8 + 11 * 64);
}

/** `mint` returns (tokenId, liquidity, amount0, amount1); an eth_call of it previews what the deposit will use. */
export function mintResult(ret: string) {
  const w = (i: number) => BigInt("0x" + body(ret).slice(i * 64, (i + 1) * 64));
  return { tokenId: w(0), liquidity: w(1), amount0: w(2), amount1: w(3) };
}

/** `decreaseLiquidity` and `collect` both return (amount0, amount1). */
export function amountsResult(ret: string) {
  const w = (i: number) => BigInt("0x" + body(ret).slice(i * 64, (i + 1) * 64));
  return { amount0: w(0), amount1: w(1) };
}

/** `positions(tokenId)`: the fields River uses (liquidity and the fees owed so far). */
export function positionResult(ret: string) {
  const w = (i: number) => BigInt("0x" + body(ret).slice(i * 64, (i + 1) * 64));
  return { token0: addr(w(2)), token1: addr(w(3)), fee: Number(w(4)), liquidity: w(7), tokensOwed0: w(10), tokensOwed1: w(11) };
}

export const encodePositions = (tokenId: bigint | string) => NPM_SEL.positions + hex32(BigInt(tokenId));

/** Collect everything owed (fees, plus principal after a decrease) to `recipient`. */
export const encodeCollect = (tokenId: bigint | string, recipient: string) =>
  NPM_SEL.collect + hex32(BigInt(tokenId)) + hex32(BigInt(recipient)) + hex32(UINT128_MAX) + hex32(UINT128_MAX);

export const encodeDecrease = (tokenId: bigint | string, liquidity: bigint, min0: bigint, min1: bigint, deadline: number) =>
  NPM_SEL.decreaseLiquidity + hex32(BigInt(tokenId)) + hex32(liquidity) + hex32(min0) + hex32(min1) + hex32(BigInt(deadline));

export const encodeBurn = (tokenId: bigint | string) => NPM_SEL.burn + hex32(BigInt(tokenId));
