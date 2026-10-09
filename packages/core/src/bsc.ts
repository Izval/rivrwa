// bsc.ts — the few BSC reads the agent needs, over plain JSON-RPC (fetch only, so it runs in Node and Workers).
//
// The planner must price the band off the pool's *current* tick, not the last hourly candle: Binance's lp-add
// derives the paired leg from the live tick, so a stale price would ask for more USDT than was planned. The
// Agentic Wallet returns only a txHash for lp-add, so the position's NFT id is read from the mint receipt.

import { PANCAKE_V3_NPM } from "./assets.ts";
import type { PoolOrientation } from "./v3.ts";

export const BSC_RPC = "https://bsc-dataseed.bnbchain.org";
/** For batched discovery reads: bsc-dataseed rate-limits JSON-RPC batches, publicnode accepts them. */
export const BSC_RPC_BATCH = "https://bsc-rpc.publicnode.com";

export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  // NPM events, all `(uint256 indexed tokenId, <word>, uint256 amount0, uint256 amount1)`.
  increase: "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f", // IncreaseLiquidity
  decrease: "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4", // DecreaseLiquidity
  collect: "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01", // Collect
};
const SEL = { slot0: "0x3850c7bd", balanceOf: "0x70a08231" };
const ZERO_TOPIC = "0x" + "0".repeat(64);

export interface RpcOpts {
  url?: string;
  fetchImpl?: typeof fetch;
}

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

export interface Receipt {
  transactionHash: string;
  status: string;
  blockNumber: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  logs: Log[];
}

export async function rpc<T>(method: string, params: unknown[], o: RpcOpts = {}): Promise<T> {
  const r = await (o.fetchImpl ?? fetch)(o.url ?? BSC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method}: HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const int24 = (w: bigint) => Number(BigInt.asIntN(24, w));
const pad = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** 18-decimal integer → number, keeping 12 decimals of precision before the float conversion. */
export const fromWei = (w: bigint) => Number(w / 1_000_000n) / 1e12;

export async function erc20Balance(token: string, owner: string, o: RpcOpts = {}): Promise<number> {
  const out = await rpc<string>("eth_call", [{ to: token, data: SEL.balanceOf + pad(owner) }, "latest"], o);
  return fromWei(word(out, 0));
}

/** Live stock price (USD per share token) and tick from the pool's slot0. Both legs are 18 dp, so no scaling. */
export async function poolState(pool: string, orientation: PoolOrientation, o: RpcOpts = {}): Promise<{ price: number; tick: number }> {
  const out = await rpc<string>("eth_call", [{ to: pool, data: SEL.slot0 }, "latest"], o);
  const sqrtP = Number(word(out, 0)) / 2 ** 96;
  const p = sqrtP * sqrtP; // token1 per token0
  return { price: orientation.stockIsToken0 ? p : 1 / p, tick: int24(word(out, 1)) };
}

export async function getReceipt(txHash: string, o: RpcOpts = {}): Promise<Receipt | null> {
  return rpc<Receipt | null>("eth_getTransactionReceipt", [txHash], o);
}

/** Poll until the tx is mined. Throws on revert or timeout; a timeout does not mean the tx failed. */
export async function waitForReceipt(txHash: string, o: RpcOpts & { timeoutMs?: number; pollMs?: number } = {}): Promise<Receipt> {
  const deadline = Date.now() + (o.timeoutMs ?? 180_000);
  for (;;) {
    const r = await getReceipt(txHash, o);
    if (r) {
      if (r.status !== "0x1") throw new Error(`tx ${txHash} reverted`);
      return r;
    }
    if (Date.now() > deadline) throw new Error(`tx ${txHash} not mined yet (timeout)`);
    await new Promise((res) => setTimeout(res, o.pollMs ?? 3000));
  }
}

/** tokenId of the Pancake v3 position minted to `owner` in this receipt (NPM Transfer from 0x0), or null. */
export function mintedNftId(r: Receipt, owner: string, npm = PANCAKE_V3_NPM): string | null {
  const log = r.logs.find((l) =>
    l.address.toLowerCase() === npm && l.topics[0] === TOPIC.transfer &&
    l.topics[1] === ZERO_TOPIC && l.topics[2]?.toLowerCase() === "0x" + pad(owner));
  return log ? BigInt(log.topics[3]).toString() : null;
}

/**
 * Stock/USD amounts of an NPM event for `nftId` in this receipt: `increase` = deposited at mint, `decrease` =
 * principal released by lp-remove, `collect` = tokens paid out (only fees when collected before decrease).
 */
export function npmAmounts(r: Receipt, event: "increase" | "decrease" | "collect", nftId: string, orientation: PoolOrientation, npm = PANCAKE_V3_NPM): { stock: number; usd: number } {
  let a0 = 0n, a1 = 0n;
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== npm || l.topics[0] !== TOPIC[event] || BigInt(l.topics[1]) !== BigInt(nftId)) continue;
    a0 += word(l.data, 1);
    a1 += word(l.data, 2);
  }
  const [stock, usd] = orientation.stockIsToken0 ? [a0, a1] : [a1, a0];
  return { stock: fromWei(stock), usd: fromWei(usd) };
}

/** Gas paid by this receipt, in BNB. */
export const gasBnb = (r: Receipt) => (r.gasUsed && r.effectiveGasPrice ? fromWei(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) : 0);

// --- Pool discovery reads (the discovery cron; ported from research/gate0/pool.mjs) ---------------------------

/** Many calls in one JSON-RPC batch; results in request order. */
export async function rpcBatch<T = string>(calls: [string, unknown[]][], o: RpcOpts = {}): Promise<T[]> {
  if (calls.length === 0) return [];
  const r = await (o.fetchImpl ?? fetch)(o.url ?? BSC_RPC_BATCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }))),
  });
  if (!r.ok) throw new Error(`rpc batch: HTTP ${r.status}`);
  const j = (await r.json()) as { id: number; result?: T; error?: { message: string } }[];
  if (!Array.isArray(j)) throw new Error("rpc batch: not a batch response");
  return j.sort((a, b) => a.id - b.id).map((x) => {
    if (x.error) throw new Error(`rpc batch: ${x.error.message}`);
    return x.result as T;
  });
}

const call = (to: string, data: string): [string, unknown[]] => ["eth_call", [{ to, data }, "latest"]];
const addrAt = (hex: string) => "0x" + hex.slice(26, 66).toLowerCase();
const enc24 = (t: number) => BigInt.asUintN(256, BigInt(t)).toString(16).padStart(64, "0");
const POOL_SEL = { liquidity: "0x1a686502", tickSpacing: "0xd0c93a7c", fee: "0xddca3f43", token0: "0x0dfe1681", token1: "0xd21220a7", decimals: "0x313ce567", ticks: "0xf30dba93" };

export interface PoolMeta {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  /** Pool fee as a fraction (2500 → 0.0025). */
  fee: number;
  tickSpacing: number;
  tick: number;
  liquidity: string;
}

export async function poolMeta(pool: string, o: RpcOpts = {}): Promise<PoolMeta> {
  const [s0, liq, ts, fee, t0, t1] = await rpcBatch([
    call(pool, SEL.slot0), call(pool, POOL_SEL.liquidity), call(pool, POOL_SEL.tickSpacing),
    call(pool, POOL_SEL.fee), call(pool, POOL_SEL.token0), call(pool, POOL_SEL.token1),
  ], o);
  const token0 = addrAt(t0), token1 = addrAt(t1);
  const [d0, d1] = await rpcBatch([call(token0, POOL_SEL.decimals), call(token1, POOL_SEL.decimals)], o);
  return {
    token0, token1, decimals0: Number(word(d0, 0)), decimals1: Number(word(d1, 0)),
    fee: Number(word(fee, 0)) / 1e6, tickSpacing: Number(BigInt.asIntN(24, word(ts, 0))),
    tick: int24(word(s0, 1)), liquidity: BigInt(liq).toString(),
  };
}

/** liquidityNet of every initialized tick within ±`spanPct` of the current tick (the gate's other-LP profile). */
export async function tickLiquidity(pool: string, tick: number, spacing: number, spanPct = 0.08, o: RpcOpts = {}): Promise<Record<string, string>> {
  const span = Math.ceil(Math.log(1 + spanPct) / Math.log(1.0001) / spacing) * spacing;
  const base = Math.floor(tick / spacing) * spacing;
  const idx: number[] = [];
  for (let t = base - span; t <= base + span; t += spacing) idx.push(t);
  const net: Record<string, string> = {};
  for (let i = 0; i < idx.length; i += 40) {
    const res = await rpcBatch(idx.slice(i, i + 40).map((t) => call(pool, POOL_SEL.ticks + enc24(t))), o);
    res.forEach((h, k) => {
      const ln = BigInt.asIntN(128, word(h, 1));
      if (ln !== 0n) net[idx[i + k]] = ln.toString();
    });
  }
  return net;
}
