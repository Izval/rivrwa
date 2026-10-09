// altana.ts — what River asks an Altana account to grant, as plain data (tested in lib.test.ts). The session may call
// only the PancakeSwap v3 position manager, and only mint / decreaseLiquidity / collect / burn; River's server then
// checks every argument it can (core/npm.ts). Each week it may move at most the caps below: the stock, USDT, and a
// little BNB for the relay's fees. Porto-style accounts refuse a session's token outflow with no cap at all, so the
// caps are also the list of tokens River may deploy.

import { PANCAKE_V3_NPM, USDT } from "../../../packages/core/src/assets.ts";
import { NPM_SEL } from "../../../packages/core/src/npm.ts";

export const SESSION_MONTHS = [1, 3, 6] as const;
export type SessionMonths = (typeof SESSION_MONTHS)[number];
/** Weekly BNB for Altana's relay fees: a cycle is 2–3 intents of well under 0.001 BNB each. */
export const FEE_CAP_BNB = 0.01;
/** BNB the account needs before the grant: the KeyStore registration fee plus the first intents' fees. */
export const MIN_BNB_TO_GRANT = 0.003;
/** Headroom on the weekly caps over today's balance, so a small top-up does not need a new grant. */
export const CAP_HEADROOM = 1.25;

export interface WeeklyCaps { stock: number; usd: number }

/** Session expiry, unix seconds. */
export const expiryFor = (months: SessionMonths, nowMs = Date.now()) => Math.floor(nowMs / 1000) + months * 30 * 86_400;

/** Default weekly caps from what the account holds, rounded up to readable numbers. */
export function defaultCaps(balance: { stock: number; usd: number }): WeeklyCaps {
  const up = (x: number, step: number) => Math.ceil((x * CAP_HEADROOM) / step) * step;
  return { stock: balance.stock > 0 ? up(balance.stock, 0.01) : 0, usd: balance.usd > 0 ? up(balance.usd, 10) : 0 };
}

/** Human amount → 18-decimal base units, exactly (no float drift past 9 decimals). */
export function toBase(x: number): bigint {
  const [i, f = ""] = x.toFixed(9).split(".");
  return BigInt(i) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
}

/** The permissions River asks for, in the SDK's shape (bigint limits; `token` omitted = native BNB). */
export function sessionPermissions(stockToken: string, caps: WeeklyCaps) {
  const npm = PANCAKE_V3_NPM as `0x${string}`;
  return {
    calls: [NPM_SEL.mint, NPM_SEL.decreaseLiquidity, NPM_SEL.collect, NPM_SEL.burn].map((signature) => ({ to: npm, signature })),
    spend: [
      ...(caps.stock > 0 ? [{ token: stockToken as `0x${string}`, limit: toBase(caps.stock), period: "week" as const }] : []),
      ...(caps.usd > 0 ? [{ token: USDT as `0x${string}`, limit: toBase(caps.usd), period: "week" as const }] : []),
      { limit: toBase(FEE_CAP_BNB), period: "week" as const },
    ],
  };
}
