// mandate.ts — the user's mandate as a JSON file. It holds no secrets: only the policy the agent must follow.
// In the product the River UI writes it; for the demo it is edited by hand (see mandates/*.example.json).

import { ASSETS, resolveAsset, type Mandate, type StreamAsset } from "../../packages/core/src/index.ts";

export interface MandateFile {
  owner: string;
  asset: string;
  signer: "agentic_wallet" | "altana";
  allocation: number;
  maxHalfWidth: number;
  exitOnDrift: number;
  skipEvents: boolean;
  /** Earnings / corporate actions for the asset (ISO instants). */
  events?: string[];
  restoreShares: boolean;
  expiresAt: string;
  /** Slippage for lp-add / lp-remove (bps). Default 100 (1%). */
  slippageBps?: number;
}

export interface LoadedMandate {
  mandate: Mandate;
  /** Resolved from the registry the caller passed (the live one in the Worker, the seed in the CLI). */
  asset: StreamAsset;
  signer: MandateFile["signer"];
  events: number[];
  slippageBps: number;
}

/** `registry` is the live asset list (registry.ts); the static seed is the default for the CLI and tests. */
export function parseMandate(f: MandateFile, registry: readonly StreamAsset[] = ASSETS): LoadedMandate {
  const bad = (m: string): never => { throw new Error(`mandate: ${m}`); };
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.owner ?? "")) bad("owner must be a 0x address");
  const asset = resolveAsset(registry, f.asset ?? "") ?? bad(`unknown asset ${f.asset}`);
  if (f.signer !== "agentic_wallet" && f.signer !== "altana") bad("signer must be agentic_wallet or altana");
  if (!(f.allocation > 0 && f.allocation <= 1)) bad("allocation must be in (0, 1]");
  if (!(f.maxHalfWidth > 0 && f.maxHalfWidth < 0.5)) bad("maxHalfWidth must be in (0, 0.5)");
  if (!(f.exitOnDrift > 0)) bad("exitOnDrift must be > 0");
  const expiresAt = Date.parse(f.expiresAt);
  if (!Number.isFinite(expiresAt)) bad("expiresAt must be an ISO date");
  const events = (f.events ?? []).map((e) => Date.parse(e));
  if (events.some((e) => !Number.isFinite(e))) bad("events must be ISO dates");
  const slippageBps = f.slippageBps ?? 100;
  if (!(Number.isInteger(slippageBps) && slippageBps >= 1 && slippageBps <= 4999)) bad("slippageBps must be an integer in [1, 4999]");
  return {
    mandate: {
      owner: f.owner.toLowerCase(), asset: asset.symbol, allocation: f.allocation, maxHalfWidth: f.maxHalfWidth,
      exitOnDrift: f.exitOnDrift, skipEvents: f.skipEvents, restoreShares: f.restoreShares, expiresAt,
    },
    asset,
    signer: f.signer,
    events,
    slippageBps,
  };
}
