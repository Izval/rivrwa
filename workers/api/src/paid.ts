// paid.ts — River's paid surface for agents: the x402 gate in front of the fitted plan, and the agent's treasury.
//
// One gate serves both doors: `GET /v1/paid/plan` (HTTP x402: 402 + `PAYMENT-REQUIRED`, then `PAYMENT-SIGNATURE`
// or `X-PAYMENT-TX`) and the MCP tool `plan_cycle` (the same challenge comes back as a tool error, and the proof
// goes in its `payment_signature` / `payment_tx` arguments). The rules live in core (x402.ts); this file adds the
// I/O: Binance's b402 facilitator, the receipt read, and KV so a proof pays for exactly one plan.
//
// The treasury is the self-funding ledger: every settled payment lands in River's agent wallet (the ERC-8004 owner)
// and is counted here, so the agent page can show what the agent has earned next to what it has spent on gas.

import { binanceWeb3, challenge, checkTransfer, getReceipt, readSignature, TX_HASH_RE, BinanceWeb3Error, type B402Kind, type Challenge } from "../../../packages/core/src/index.ts";
import { egressFetch } from "../../agent/src/egress.ts";
import type { Env } from "./index.ts";

export const PLAN_PRICE_USD = 0.1;
const KINDS_KEY = "b402:kinds";
export const TREASURY_KEY = "treasury";

export interface Treasury {
  paidCalls: number;
  revenueUsd: number;
  byRail: Record<string, number>;
  recent: { at: number; rail: string; usd: number; payer: string | null; tx: string | null; resource: string }[];
}

export type Proof = { signature?: string | null; tx?: string | null };
export type Charge = { ok: true; rail: string; payer: string | null; tx: string | null } | { ok: false; status: 402 | 409 | 503; challenge: Challenge; reason: string };

const binance = (env: Env) => env.BINANCE_WEB3_API_KEY && env.BINANCE_WEB3_SECRET_KEY
  ? binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW)) : null;

/** The b402 kinds Binance supports for this key, cached an hour; [] while the key lacks the B402 permission. */
async function b402Kinds(env: Env): Promise<B402Kind[]> {
  const hit = await env.RIVER_KV.get<B402Kind[]>(KINDS_KEY, "json");
  if (hit) return hit;
  const bw = binance(env);
  let kinds: B402Kind[] = [];
  if (bw) kinds = await bw.b402Supported().then((d) => d.kinds ?? []).catch((e) => {
    console.warn(`b402 supported: ${e instanceof BinanceWeb3Error ? `${e.code} ${e.message}` : (e as Error).message}`);
    return [];
  });
  await env.RIVER_KV.put(KINDS_KEY, JSON.stringify(kinds), { expirationTtl: 3600 });
  return kinds;
}

export async function planChallenge(env: Env, url: string, error?: string): Promise<Challenge | null> {
  if (!env.AGENT_WALLET) return null;
  return challenge({
    usd: PLAN_PRICE_USD, payTo: env.AGENT_WALLET, url, error, kinds: await b402Kinds(env),
    description: "River cycle plan fitted to your inventory: closed window, IVL band in pool ticks, no-swap deposit, Binance lp-add args",
  });
}

async function record(env: Env, e: Treasury["recent"][number]) {
  const t = (await env.RIVER_KV.get<Treasury>(TREASURY_KEY, "json")) ?? { paidCalls: 0, revenueUsd: 0, byRail: {}, recent: [] };
  t.paidCalls++;
  t.revenueUsd = Math.round((t.revenueUsd + e.usd) * 100) / 100;
  t.byRail[e.rail] = (t.byRail[e.rail] ?? 0) + 1;
  t.recent = [e, ...t.recent].slice(0, 25);
  await env.RIVER_KV.put(TREASURY_KEY, JSON.stringify(t));
}

/** Verifies and settles one proof for `url`. Nothing is served unless this returns ok. */
export async function charge(env: Env, url: string, proof: Proof): Promise<Charge> {
  const c = await planChallenge(env, url);
  if (!c) return { ok: false, status: 503, challenge: challenge({ usd: PLAN_PRICE_USD, payTo: "0x" + "0".repeat(40), url, description: "" }), reason: "paid plans are not configured (AGENT_WALLET)" };
  const fail = (reason: string, status: 402 | 409 = 402): Charge => ({ ok: false, status, challenge: { ...c, error: reason }, reason });

  if (proof.signature) {
    const r = readSignature(proof.signature, c);
    if (!r.ok) return fail(r.reason);
    const bw = binance(env);
    if (!bw) return fail("b402 is not available; pay with a USDT transfer instead");
    const v = await bw.b402Verify(r.payload, r.requirement).catch((e) => ({ isValid: false, invalidReason: (e as Error).message, payer: null }));
    if (!v.isValid) return fail(`b402 verify: ${v.invalidReason ?? "rejected"}`);
    const s = await bw.b402Settle(r.payload, r.requirement).catch((e) => ({ success: false, errorReason: (e as Error).message, transaction: "", payer: null }));
    if (!s.success) return fail(`b402 settle: ${s.errorReason ?? "failed"}`);
    await record(env, { at: Date.now(), rail: `b402:${r.requirement.extra.assetTransferMethod}`, usd: PLAN_PRICE_USD, payer: s.payer ?? v.payer ?? null, tx: s.transaction || null, resource: url });
    return { ok: true, rail: "b402", payer: s.payer ?? null, tx: s.transaction || null };
  }

  if (proof.tx) {
    const tx = proof.tx.trim().toLowerCase();
    if (!TX_HASH_RE.test(tx)) return fail("X-PAYMENT-TX must be a transaction hash");
    const used = `x402:tx:${tx}`;
    if (await env.RIVER_KV.get(used)) return fail("this payment was already used", 409);
    const rec = await getReceipt(tx, { url: env.BSC_RPC_URL }).catch(() => null);
    const chk = checkTransfer(rec, c);
    if (!chk.ok) return fail(chk.reason);
    // KV is eventually consistent; two racing retries of one hash could both pass. Each costs the attacker
    // nothing extra but a duplicate plan, which is read-only data, so this is acceptable.
    await env.RIVER_KV.put(used, JSON.stringify({ at: Date.now(), url }));
    await record(env, { at: Date.now(), rail: "transfer", usd: Number(chk.paid / 10n ** 14n) / 1e4, payer: chk.from, tx, resource: url });
    return { ok: true, rail: "transfer", payer: chk.from, tx };
  }

  return fail("Payment Required");
}
