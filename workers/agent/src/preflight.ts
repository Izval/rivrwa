// preflight.ts — "is this mandate ready for the next closed window?", answered before the window opens. The first
// mainnet cycle is the only full one before the deadline, so everything a live tick needs is checked ahead of
// time: the signer can sign until the exit, the wallet holds something to deploy and BNB for gas, the mandate is
// active and valid past the exit, alerts reach the owner, and a rehearsal (a dry-run of the entry tick at the
// window's entry time) went through the signer's own preview.
//
// `preflightChecks` is pure (facts in, items out) so it is unit-tested; `gatherPreflight` reads the facts.

import { clockState, rpc, erc20Balance, poolState, SIGNAL_DEFAULTS, USDT } from "../../../packages/core/src/index.ts";
import type { StreamAsset } from "../../../packages/core/src/index.ts";
import type { Session } from "../../../agent/src/signer.ts";
import type { AgentState } from "../../../agent/src/store.ts";

export type Level = "ok" | "warn" | "fail";
export interface PreflightItem { id: string; level: Level; label: string; detail: string }
export interface Preflight { ready: boolean; entryAt: number; exitAt: number; items: PreflightItem[] }

export interface PreflightFacts {
  now: number;
  /** Entry and exit of the next (or current) closed window, UTC ms. */
  entryAt: number;
  exitAt: number;
  session: Session;
  asset: Pick<StreamAsset, "symbol" | "enabled"> & { note?: string };
  status: "active" | "paused";
  allocation: number;
  mandateExpiresAt: number;
  state: Pick<AgentState, "halted" | "position">;
  stock: number;
  usd: number;
  price: number;
  bnb: number;
  telegram: boolean;
  /** Last rehearsal outcome recorded in ticks, if any. */
  rehearsal: { at: number; kind: string; note: string } | null;
}

/** Gas for enter + claim + remove on BSC is well under 0.001 BNB; keep a margin for a retry. */
export const MIN_BNB = 0.002;
const SESSION_MARGIN = 30 * 60_000;
const REHEARSAL_FRESH = 36 * 3_600_000;

const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const usd = (x: number) => `$${x.toFixed(2)}`;

export function preflightChecks(f: PreflightFacts): Preflight {
  const items: PreflightItem[] = [];
  const add = (id: string, level: Level, label: string, detail: string) => items.push({ id, level, label, detail });

  if (f.state.halted) add("halted", "fail", "Agent halted", `${f.state.halted}. Resume it once the cause is fixed.`);

  const signEnd = f.session.expiresAt - SESSION_MARGIN;
  if (!f.session.connected) add("session", "fail", "Signer connected", "River cannot sign for this wallet. Connect it again.");
  else if (signEnd >= f.exitAt) add("session", "ok", "Signer connected", `River can sign until ${at(f.session.expiresAt)}, past this window's exit.`);
  else if (signEnd - Math.max(f.now, f.entryAt) >= SIGNAL_DEFAULTS.exitBufferMs * 3)
    add("session", "warn", "Signer connected", `The session ends at ${at(f.session.expiresAt)}, before the exit. River will leave early; renew to stay the whole window.`);
  else add("session", "fail", "Signer connected", `The session ends at ${at(f.session.expiresAt)}, too early for this window. Renew it.`);

  if (!f.asset.enabled) add("asset", "fail", `${f.asset.symbol} enabled`, `River does not enter ${f.asset.symbol} right now${f.asset.note ? ` (${f.asset.note})` : ""}.`);
  else add("asset", "ok", `${f.asset.symbol} enabled`, "The pool passed River's gate.");

  add("status", f.status === "active" ? "ok" : "warn", "Mandate active",
    f.status === "active" ? "River will act on this mandate." : "The mandate is paused. Activate it to join the window.");

  // A mandate that ends inside the window is how an owner asks for an early exit; it only fails when it would
  // leave no time to earn anything after the entry.
  if (f.mandateExpiresAt <= f.entryAt + SIGNAL_DEFAULTS.exitBufferMs) add("expiry", "fail", "Mandate valid", `It expires ${at(f.mandateExpiresAt)}, too close to the entry. Extend it.`);
  else if (f.mandateExpiresAt <= f.exitAt) add("expiry", "warn", "Mandate valid", `It ends ${at(f.mandateExpiresAt)}, inside this window: River will leave the pool then, before the usual exit.`);
  else add("expiry", "ok", "Mandate valid", `Valid until ${at(f.mandateExpiresAt)}.`);

  const value = (f.stock * f.price + f.usd) * f.allocation;
  if (f.state.position) add("funds", "ok", "Funds to deploy", "A position is already open.");
  else if (value < 1) add("funds", "fail", "Funds to deploy", `The allocated share of the wallet is worth ${usd(value)}. Add ${f.asset.symbol} and USDT.`);
  else if (f.stock <= 0 || f.usd <= 0)
    add("funds", "warn", "Funds to deploy", `${usd(value)} allocated, but only ${f.stock > 0 ? f.asset.symbol : "USDT"} is in the wallet: the band will sit on one side of the price and earn only if it moves there.`);
  else add("funds", "ok", "Funds to deploy", `${usd(value)} allocated (${f.stock.toFixed(4)} ${f.asset.symbol} + ${usd(f.usd)} USDT, times ${Math.round(f.allocation * 100)}%).`);

  add("gas", f.bnb >= MIN_BNB ? "ok" : "fail", "BNB for gas",
    f.bnb >= MIN_BNB ? `${f.bnb.toFixed(4)} BNB.` : `${f.bnb.toFixed(4)} BNB; keep at least ${MIN_BNB} BNB in the wallet.`);

  add("telegram", f.telegram ? "ok" : "warn", "Telegram alerts", f.telegram ? "River reports each step." : "Link Telegram to hear when River enters and exits.");

  const r = f.rehearsal;
  if (f.state.position) add("rehearsal", "ok", "Rehearsal", "Not needed while a position is open.");
  else if (!r || f.now - r.at > REHEARSAL_FRESH) add("rehearsal", "warn", "Rehearsal", "Run a rehearsal: River previews the entry through your signer without sending anything.");
  else if (r.kind === "previewed") add("rehearsal", "ok", "Rehearsal", `Passed ${at(r.at)}: ${r.note}`);
  else add("rehearsal", r.kind === "blocked" || r.kind === "halted" ? "fail" : "warn", "Rehearsal", `${r.kind} ${at(r.at)}: ${r.note}`);

  return { ready: items.every((i) => i.level !== "fail"), entryAt: f.entryAt, exitAt: f.exitAt, items };
}

/** Entry and exit of the closed window a mandate would join next (the current one while it is open). */
export function nextWindow(now: number) {
  const w = clockState(now).window;
  return { entryAt: w.start + SIGNAL_DEFAULTS.settleMs, exitAt: w.end - SIGNAL_DEFAULTS.exitBufferMs };
}

/** Wallet reads for the checklist, over the same RPC options the runner uses. */
export async function walletFacts(asset: StreamAsset, owner: string, o: Parameters<typeof rpc>[2]) {
  const [stock, usdBal, pool, wei] = await Promise.all([
    erc20Balance(asset.token, owner, o), erc20Balance(USDT, owner, o), poolState(asset.pool, asset, o),
    rpc<string>("eth_getBalance", [owner, "latest"], o),
  ]);
  return { stock, usd: usdBal, price: pool.price, bnb: Number(BigInt(wei)) / 1e18 };
}
