// x402.ts — how other agents pay for River's plan: x402 v2 challenges, and the two proofs River accepts.
//
// River sells one thing to agents: a cycle plan fitted to *their* inventory (closed window, IVL band in pool ticks,
// the no-swap deposit and the Binance `investmentId` to call `lp-add` with). The public signal stays free; the fit
// is the product. Payments go to River's agent wallet, the address that owns its ERC-8004 identity (erc8004.ts),
// so what the agent earns sits on-chain next to who it is, and pays for its own gas.
//
// Two rails, both listed in one 402:
//   - b402: x402 v2 with Binance as the facilitator. The buyer signs (EIP-3009 for U, Permit2 for USDT) and sends
//     `PAYMENT-SIGNATURE`; River has Binance verify and settle it, gasless for the buyer. Needs a key with the
//     "B402 Payments" permission, so the 402 offers it only when `supported` answers.
//   - transfer: the buyer sends USDT itself and retries with the tx hash (`X-PAYMENT-TX`). BSC's USDT has no
//     EIP-3009, so this is the rail that needs nothing but a wallet. River checks the receipt and burns the hash.

import type { Receipt } from "./bsc.ts";
import type { B402Kind } from "./binance.ts";
import { USDT } from "./assets.ts";

export const NETWORK = "eip155:56" as const;
export const HEADERS = { required: "PAYMENT-REQUIRED", signature: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE", tx: "X-PAYMENT-TX" } as const;

/** The b402 tokens on BSC and the EIP-712 domain the facilitator advertises for each (Binance's own demo seller). */
export const B402_TOKENS = [
  { symbol: "USDT", asset: USDT, name: "Tether USD", version: "1", method: "permit2-exact" },
  { symbol: "U", asset: "0xce24439f2d9c6a2289f741120fe202248b666666", name: "United Stables", version: "1", method: "eip3009" },
] as const;

export interface Requirement {
  scheme: "exact";
  network: typeof NETWORK;
  /** Base units; every token here has 18 decimals. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface Challenge {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: "application/json" };
  accepts: Requirement[];
}

const units = (usd: number) => (BigInt(Math.round(usd * 100)) * 10n ** 16n).toString();

/** The 402 body (also sent base64 in `PAYMENT-REQUIRED`, and as a paid MCP tool's error). */
export function challenge(o: { usd: number; payTo: string; url: string; description: string; kinds?: B402Kind[]; error?: string }): Challenge {
  const base = { scheme: "exact" as const, network: NETWORK, amount: units(o.usd), payTo: o.payTo.toLowerCase(), maxTimeoutSeconds: 600 };
  const accepts: Requirement[] = [];
  for (const t of B402_TOKENS) {
    const k = (o.kinds ?? []).find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === NETWORK
      && k.extra.name === t.name && k.extra.version === t.version && k.extra.assetTransferMethod === t.method
      && (t.method !== "permit2-exact" || !!k.extra.spenderAddress));
    if (k) accepts.push({ ...base, asset: t.asset, extra: { ...k.extra } });
  }
  accepts.push({ ...base, asset: USDT, extra: { assetTransferMethod: "transfer", proof: "tx_hash", header: HEADERS.tx, mcpArgument: "payment_tx", symbol: "USDT", decimals: 18 } });
  return { x402Version: 2, error: o.error ?? "Payment Required", resource: { url: o.url, description: o.description, mimeType: "application/json" }, accepts };
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
export const encodeHeader = (v: unknown) => b64(JSON.stringify(v));

export interface PaymentPayload { x402Version: 2; resource: unknown; accepted: Requirement; payload: { signature: string; [k: string]: unknown }; extensions?: unknown }

/** Decodes `PAYMENT-SIGNATURE` and checks it accepts one of *our* b402 requirements, field by field. */
export function readSignature(header: string, c: Challenge): { ok: true; payload: PaymentPayload; requirement: Requirement } | { ok: false; reason: string } {
  let p: PaymentPayload;
  try { p = JSON.parse(unb64(header.trim())); } catch { return { ok: false, reason: "PAYMENT-SIGNATURE is not base64 JSON" }; }
  if (p?.x402Version !== 2) return { ok: false, reason: "unsupported x402Version (expected 2)" };
  const a = p.accepted;
  const req = c.accepts.find((r) => r.extra.assetTransferMethod !== "transfer" && a && r.asset === a.asset?.toLowerCase()
    && r.amount === a.amount && r.payTo === a.payTo?.toLowerCase() && r.network === a.network && r.scheme === a.scheme
    && JSON.stringify(r.extra) === JSON.stringify(a.extra));
  if (!req) return { ok: false, reason: "payment does not match a current requirement" };
  if (typeof p.payload?.signature !== "string") return { ok: false, reason: "payload has no signature" };
  return { ok: true, payload: p, requirement: req };
}

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type ProofCheck = { ok: true; paid: bigint; from: string } | { ok: false; reason: string };

/** Transfer rail: whether a mined receipt carries a USDT transfer to `payTo` of at least the amount. */
export function checkTransfer(r: Receipt | null, c: Challenge): ProofCheck {
  const req = c.accepts.find((x) => x.extra.assetTransferMethod === "transfer")!;
  if (!r) return { ok: false, reason: "transaction not mined yet" };
  if (r.status !== "0x1") return { ok: false, reason: "transaction reverted" };
  const to = req.payTo.replace(/^0x/, "").padStart(64, "0");
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== req.asset || l.topics[0] !== TRANSFER || l.topics[2]?.toLowerCase().slice(2) !== to) continue;
    const paid = BigInt(l.data);
    if (paid >= BigInt(req.amount)) return { ok: true, paid, from: "0x" + l.topics[1].slice(-40).toLowerCase() };
  }
  return { ok: false, reason: `no USDT transfer of at least ${Number(BigInt(req.amount) / 10n ** 14n) / 1e4} to ${req.payTo}` };
}
