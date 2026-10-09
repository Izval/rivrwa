// signer.ts — the seam between planning and signing. The runner decides every operation from the mandate
// (planCycle) and a Signer only carries it out from the user's own wallet: flow A is the Binance Agentic
// Wallet, flow B an Altana smart account with a session key. Neither may choose amounts or ranges itself.

import type { StreamAsset, TickRange } from "../../packages/core/src/index.ts";

export type LpOp =
  | { kind: "add"; asset: StreamAsset; range: TickRange; token: string; amount: number; slippageBps: number }
  | { kind: "claim"; asset: StreamAsset; nftId: string }
  | { kind: "remove"; asset: StreamAsset; nftId: string; slippageBps: number };

export interface Preview {
  /** Signed per-token change for the wallet: negative = outflow. Keyed by lowercase token address. */
  balanceChange: { token: string; symbol: string; amount: number }[];
  warnings: string[];
  raw: unknown;
}

export interface Session {
  connected: boolean;
  /**
   * Last instant (UTC ms) the signer can still sign; the runner leaves the pool before it. For the Agentic
   * Wallet this is the hard cap (signInMaxTime): the agent's own calls keep the 48h idle timeout from firing.
   */
  expiresAt: number;
  /** When the session would end if nothing used it (Agentic Wallet idle sign-out), for display. */
  idleExpiresAt?: number;
  /** Remaining USD the wallet will let lp-add spend today, when the signer enforces one. */
  quotaUsd?: number;
  warnings: string[];
}

export interface Signer {
  readonly kind: "agentic_wallet" | "altana";
  /** The wallet's BSC address; must equal the mandate owner. */
  address(): Promise<string>;
  session(): Promise<Session>;
  /** Dry run: never broadcasts. */
  preview(op: LpOp): Promise<Preview>;
  /** Broadcasts and returns the tx hash. A hash means submitted, not mined. */
  execute(op: LpOp): Promise<string>;
}
