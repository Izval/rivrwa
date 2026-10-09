// altana.ts — flow B's Signer: an Altana smart account that River drives with a session key the user granted once
// with their passkey (1, 3 or 6 months). The session key lives sealed in D1; the browser only ever saw its public
// key.
//
// Calldata still comes from Binance's DeFi builders (lp-add/calculate, lp-add, lp-remove) with `address` set to the
// account, but River never signs it as returned. `npmGuard` (core/npm.ts) keeps only NPM calls whose recipient is
// the account, since Altana cannot constrain arguments. The mint's minimums are then reset from a fresh eth_call
// of that same mint, because Binance's are far looser than asked. Claims are River's own `collect`. If lp-remove
// comes back in a shape the guard refuses, or the API is down at exit time, River builds decreaseLiquidity +
// collect itself from the position on-chain: a window must never be left open for want of a builder.
//
// Last, every call is dry-run through Binance's Transaction API (`simulate`, core/simguard.ts): if any token would
// move outside account ↔ pool, or an allowance would change, River does not sign. If the simulator is down, an
// entry is refused (it can wait for the next tick) but an exit goes ahead on the other guards (it cannot wait).
//
// Everything that touches the network is injected (`AltanaBackend`), so this file runs under `node --test`; the
// SDK wiring lives in altana-sdk.ts.

import {
  npmGuard, decodeMint, withMintMins, mintResult, amountsResult, positionResult, encodeCollect, encodeDecrease,
  encodePositions, GuardError, NPM_SEL, PANCAKE_V3_NPM, USDT, fromWei, simulateCalls, type BinanceWeb3, type Call, type StreamAsset,
} from "../../../packages/core/src/index.ts";
import type { LpOp, Preview, Session, Signer } from "../../../agent/src/signer.ts";
import { formatAmount } from "../../../agent/src/agentic-wallet.ts";

export interface AltanaBackend {
  /** The smart account (lowercase); the mandate owner. */
  account: string;
  /** Session expiry, unix seconds, and whether River's key was revoked or deleted. */
  expiry: number;
  revoked: boolean;
  build: Pick<BinanceWeb3, "lpAddCalculate" | "lpAdd" | "lpRemove"> & Partial<Pick<BinanceWeb3, "simulate">>;
  /** eth_call from the account at the latest block; returns the raw return data. */
  call(to: string, data: string): Promise<string>;
  /** Submits the calls in one Altana intent signed by the session key; returns the tx hash once included. */
  send(calls: Call[]): Promise<string>;
  now?: () => number;
}

/** Minimum left on the session before River warns the owner to renew. */
export const RENEW_WARN_MS = 7 * 86_400_000;
const DEADLINE_S = 20 * 60;

const bps = (x: bigint, slippageBps: number) => (x * BigInt(10_000 - slippageBps)) / 10_000n;
const legs = (a: StreamAsset) => (a.stockIsToken0 ? [a.token, USDT] : [USDT, a.token]).map((t) => t.toLowerCase());
const symbolOf = (a: StreamAsset, token: string) => (token === a.token.toLowerCase() ? a.symbol : "USDT");

export class AltanaSigner implements Signer {
  readonly kind = "altana" as const;
  private b: AltanaBackend;
  constructor(backend: AltanaBackend) {
    this.b = { ...backend, account: backend.account.toLowerCase() };
  }
  private now() { return (this.b.now ?? Date.now)(); }

  async address() { return this.b.account; }

  async session(): Promise<Session> {
    const expiresAt = this.b.expiry * 1000;
    const connected = !this.b.revoked && this.now() < expiresAt;
    const warnings = connected && expiresAt - this.now() < RENEW_WARN_MS ? [`the Altana session ends ${new Date(expiresAt).toISOString()}; renew it`] : [];
    return { connected, expiresAt, warnings };
  }

  async preview(op: LpOp): Promise<Preview> {
    const { calls, change, warnings } = await this.prepare(op);
    return { balanceChange: change, warnings, raw: { calls } };
  }

  async execute(op: LpOp): Promise<string> {
    const s = await this.session();
    if (!s.connected) throw new Error("the Altana session has ended or was revoked");
    const { calls } = await this.prepare(op);
    return this.b.send(calls);
  }

  /** The guarded calls for `op`, with River's minimums, and the balance change an eth_call of them predicts. */
  private async prepare(op: LpOp): Promise<{ calls: Call[]; change: Preview["balanceChange"]; warnings: string[] }> {
    const p = await this.build(op);
    const sim = this.b.build.simulate;
    if (!sim) return { ...p, warnings: [...p.warnings, "no transaction simulator configured"] };
    try {
      await simulateCalls(sim, p.calls, { account: this.b.account, pool: op.asset.pool });
    } catch (e) {
      if (e instanceof GuardError || op.kind === "add") throw e instanceof GuardError ? e : new Error(`simulation unavailable, not entering: ${(e as Error).message}`);
      p.warnings.push(`simulation unavailable (${(e as Error).message}); exiting on the calldata guard alone`);
    }
    return p;
  }

  private async build(op: LpOp): Promise<{ calls: Call[]; change: Preview["balanceChange"]; warnings: string[] }> {
    const a = op.asset, me = this.b.account;
    const [t0, t1] = legs(a);
    const change = (a0: bigint, a1: bigint, sign: 1 | -1) =>
      [[t0, a0], [t1, a1]].filter(([, x]) => x !== 0n).map(([t, x]) => ({ token: t as string, symbol: symbolOf(a, t as string), amount: sign * fromWei(x as bigint) }));
    const deadline = Math.floor(this.now() / 1000) + DEADLINE_S;

    if (op.kind === "add") {
      const ticks = { tickLower: String(op.range.tickLower), tickUpper: String(op.range.tickUpper) };
      const calc = await this.b.build.lpAddCalculate({ address: me, investmentId: a.investmentId, inputToken: { tokenAddress: op.token, amount: formatAmount(op.amount) }, ...ticks });
      const tokenList = calc.outputs.map((o) => ({ tokenAddress: o.tokenAddress, amount: o.amount }));
      if (!tokenList.some((t) => t.tokenAddress.toLowerCase() === op.token.toLowerCase())) tokenList.push({ tokenAddress: op.token, amount: formatAmount(op.amount) });
      const built = await this.b.build.lpAdd({ address: me, investmentId: a.investmentId, tokenList, ...ticks, slippageBps: String(op.slippageBps) });
      const [mint] = npmGuard(built.dataList, me);
      const m = decodeMint(mint.data);
      if (m.tickLower !== op.range.tickLower || m.tickUpper !== op.range.tickUpper) throw new GuardError(`mint ticks ${m.tickLower}..${m.tickUpper} differ from the plan`);
      if ([m.token0, m.token1].join() !== [t0, t1].join()) throw new GuardError("mint tokens differ from the pool");
      const used = mintResult(await this.b.call(mint.to, mint.data));
      const data = withMintMins(mint.data, bps(used.amount0, op.slippageBps), bps(used.amount1, op.slippageBps), deadline);
      return { calls: [{ ...mint, data }], change: change(used.amount0, used.amount1, -1), warnings: [] };
    }

    if (op.kind === "claim") {
      const data = encodeCollect(op.nftId, me);
      const got = amountsResult(await this.b.call(PANCAKE_V3_NPM, data));
      return { calls: [{ to: PANCAKE_V3_NPM, data, value: "0x0" }], change: change(got.amount0, got.amount1, 1), warnings: [] };
    }

    // remove: Binance's builder first, River's own encoding if it is refused or unavailable.
    const warnings: string[] = [];
    let calls: Call[];
    try {
      const built = await this.b.build.lpRemove({ address: me, investmentId: a.investmentId, nftId: op.nftId, ratio: "1", slippageBps: String(op.slippageBps) });
      // An empty position NFT is harmless; a burn that meets a dust of owed tokens would revert the whole exit.
      calls = npmGuard(built.dataList, me).filter((c) => !c.data.startsWith(NPM_SEL.burn));
    } catch (e) {
      warnings.push(`lp-remove from Binance not used (${(e as Error).message}); River encoded the withdrawal itself`);
      const pos = positionResult(await this.b.call(PANCAKE_V3_NPM, encodePositions(op.nftId)));
      calls = [
        { to: PANCAKE_V3_NPM, data: encodeDecrease(op.nftId, pos.liquidity, 0n, 0n, deadline), value: "0x0" },
        { to: PANCAKE_V3_NPM, data: encodeCollect(op.nftId, me), value: "0x0" },
      ];
    }
    // Reset the decrease's minimums from what it returns right now, and its deadline (words 2, 3 and 4).
    let out = { amount0: 0n, amount1: 0n };
    calls = await Promise.all(calls.map(async (c) => {
      if (!c.data.startsWith(NPM_SEL.decreaseLiquidity)) return c;
      const got = amountsResult(await this.b.call(c.to, c.data));
      out = got;
      const body = c.data.slice(10);
      const w = (x: bigint) => x.toString(16).padStart(64, "0");
      return { ...c, data: NPM_SEL.decreaseLiquidity + body.slice(0, 128) + w(bps(got.amount0, op.slippageBps)) + w(bps(got.amount1, op.slippageBps)) + w(BigInt(deadline)) };
    }));
    return { calls, change: change(out.amount0, out.amount1, 1), warnings };
  }
}
