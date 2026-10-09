// agentic-wallet.ts — flow A: the Binance Agentic Wallet, driven through its `baw` CLI (@binance/agentic-wallet).
//
// The wallet is MPC and paired in the Binance App; spend limits and the session length are set there, not
// here. Every call uses `--json`: success is {"success":true,"data":…}, failure {"success":false,"error":…}
// with exit code 1. The session is stored per machine (~/.baw), so the runner must run where `baw auth
// signin` was done. lp-add returns only a txHash; the NFT id is read from the receipt by the runner.

import { CHAIN_ID } from "../../packages/core/src/index.ts";
import type { LpOp, Preview, Session, Signer } from "./signer.ts";

export class BawError extends Error {
  readonly code: string;
  readonly errorName: string;
  constructor(code: string, errorName: string, message: string) {
    super(`baw ${errorName || code}: ${message}`);
    this.code = code;
    this.errorName = errorName;
  }
}

/** Runs the CLI and returns stdout, whatever the exit code (errors are reported inside the JSON). */
export type BawRunner = (args: string[]) => Promise<string>;


/** Human-readable token amount, rounded down so the wallet is never asked for more than planned. */
export const formatAmount = (x: number, dp = 8) => {
  const s = (Math.floor(x * 10 ** dp) / 10 ** dp).toFixed(dp);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

function opArgs(op: LpOp): string[] {
  switch (op.kind) {
    case "add":
      return ["--investmentId", op.asset.investmentId, "--tokenAddress", op.token, "--amount", formatAmount(op.amount),
        "--tickLower", String(op.range.tickLower), "--tickUpper", String(op.range.tickUpper), "--slippageBps", String(op.slippageBps)];
    case "remove":
      return ["--investmentId", op.asset.investmentId, "--nftId", op.nftId, "--ratio", "1", "--slippageBps", String(op.slippageBps)];
    case "claim":
      return ["--claimType", "LP_FEE", "--investmentId", op.asset.investmentId, "--nftId", op.nftId, "--binanceChainId", String(CHAIN_ID)];
  }
}

const COMMAND = { add: "lp-add", remove: "lp-remove", claim: "claim" } as const;
const PREVIEW_ACTION = { add: "LP-ADD", remove: "LP-REMOVE", claim: "CLAIM" } as const;

export class AgenticWalletSigner implements Signer {
  readonly kind = "agentic_wallet";
  private readonly run: BawRunner;

  constructor(run: BawRunner) {
    this.run = run;
  }

  private async call<T>(args: string[]): Promise<T> {
    const out = await this.run([...args, "--json"]);
    let j: { success?: boolean; data?: T; error?: { code?: string | number; name?: string; message?: string } };
    try {
      j = JSON.parse(out);
    } catch {
      throw new BawError("PARSE", "", `non-JSON output: ${out.slice(0, 200)}`);
    }
    if (!j.success) throw new BawError(String(j.error?.code ?? ""), j.error?.name ?? "", j.error?.message ?? "unknown error");
    return j.data as T;
  }

  async address(): Promise<string> {
    const d = await this.call<{ addresses: { binanceChainId: string; address: string }[] }>(["wallet", "address"]);
    const bsc = d.addresses.find((a) => a.binanceChainId === String(CHAIN_ID));
    if (!bsc) throw new BawError("NO_BSC", "", "the wallet has no BSC address");
    return bsc.address.toLowerCase();
  }

  async session(): Promise<Session> {
    const st = await this.call<{ status: string }>(["wallet", "status"]);
    if (st.status !== "CONNECTED") return { connected: false, expiresAt: 0, warnings: [`wallet status is ${st.status}: run \`baw auth signin\``] };
    const s = await this.call<{
      sessionExpireTime?: string; inactiveSignOutTime?: string; signInMaxTime?: string; abnormalTxnHandling?: string;
      defiQuotaLeft?: number; tradeAllTokens?: boolean;
    }>(["wallet", "settings"]);
    const at = (t?: string) => (t ? Date.parse(t) : NaN);
    // Observed: sessionExpireTime = min(inactiveSignOutTime, signInMaxTime); any command pushes the idle time
    // 48h out, up to signInMaxTime (7 days after sign-in). The runner calls baw every tick of a window, so the
    // hard cap is what bounds a cycle.
    const idle = [at(s.sessionExpireTime), at(s.inactiveSignOutTime)].filter(Number.isFinite);
    const hard = at(s.signInMaxTime);
    const ends = Number.isFinite(hard) ? [hard] : idle;
    const warnings: string[] = [];
    if (!ends.length) warnings.push("session expiry unknown: make sure the session outlasts the window");
    if (s.abnormalTxnHandling === "NeedConfirmation") warnings.push("abnormalTxnHandling=NeedConfirmation: a flagged tx will wait for approval in the Binance App");
    if (s.tradeAllTokens === false) warnings.push("tradeAllTokens=false: the stock token must be on the wallet's allowed list");
    return {
      connected: true, expiresAt: ends.length ? Math.min(...ends) : Infinity,
      idleExpiresAt: idle.length ? Math.min(...idle) : undefined, quotaUsd: s.defiQuotaLeft, warnings,
    };
  }

  async preview(op: LpOp): Promise<Preview> {
    const d = await this.call<{ balanceChange?: { tokenAddress?: string; tokenSymbol?: string; amount: string }[]; warnings?: unknown[] }>(
      ["defi", "preview", "--action", PREVIEW_ACTION[op.kind], ...opArgs(op)]);
    return {
      balanceChange: (d.balanceChange ?? []).map((b) => ({ token: (b.tokenAddress ?? "").toLowerCase(), symbol: b.tokenSymbol ?? "", amount: Number(b.amount) })),
      warnings: (d.warnings ?? []).map((w) => (typeof w === "string" ? w : JSON.stringify(w))),
      raw: d,
    };
  }

  async execute(op: LpOp): Promise<string> {
    const d = await this.call<{ txHash?: string }>(["defi", COMMAND[op.kind], ...opArgs(op)]);
    if (!d.txHash) throw new BawError("NO_TX", "", `${COMMAND[op.kind]} returned no txHash`);
    return d.txHash;
  }
}
