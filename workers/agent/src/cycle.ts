// cycle.ts — what one cron event does. Every 5 minutes each active mandate gets a tick of the same runner the
// CLI uses (agent/src/runner.ts), unless a pure clock check shows there is nothing to do: no position, no tx
// pending, and the closed window has not reached its entry time. That keeps a weekday event free of network
// calls. Once an hour, flow A sessions get a keep-alive (so the 48h idle sign-out never fires) and a renewal
// reminder when the 7-day cap would cut the next window short; flow B sessions get altanaWatch (altana-account.ts).

import {
  clockState, fetchOhlcvHistory, fillGaps, poolState, erc20Balance, getReceipt, SIGNAL_DEFAULTS,
  type Candle, type StreamAsset,
} from "../../../packages/core/src/index.ts";
import { AgenticWalletSigner } from "../../../agent/src/agentic-wallet.ts";
import { parseMandate } from "../../../agent/src/mandate.ts";
import { tick, type Deps, type Mode, type TickOutcome } from "../../../agent/src/runner.ts";
import type { Signer } from "../../../agent/src/signer.ts";
import { remoteBaw, type BawEnv } from "./baw.ts";
import { altanaSigner } from "./altana-account.ts";
import { egressFetch, rpcOpts } from "./egress.ts";
import { loadRegistry, type RegistryEnv } from "./registry.ts";
import { activeMandates, allBawSessions, cyclesOf, d1Store, markReminded, recordTick, setBawExpiry, type MandateRow } from "./db.ts";
import { cycleMessage, escapeHtml, notifyOwner, type TelegramEnv } from "./telegram.ts";

export interface AgentEnv extends BawEnv, TelegramEnv, RegistryEnv {
  INTERNAL_KEY: string;
  APP_URL?: string;
  BSC_RPC_URL?: string;
  /** Flow B builds calldata with Binance's DeFi API itself (flow A's baw CLI carries its own credentials). */
  BINANCE_WEB3_API_KEY?: string;
  BINANCE_WEB3_SECRET_KEY?: string;
  /** Optional private BSC RPC for the Altana SDK's own reads. */
  ALTANA_RPC_URL?: string;
}

/** A Signer whose construction is async (flow B reads its account row first), usable where a Signer is expected. */
function lazySigner(kind: Signer["kind"], make: () => Promise<Signer>): Signer {
  let p: Promise<Signer> | null = null;
  const get = () => (p ??= make());
  return {
    kind,
    address: async () => (await get()).address(),
    session: async () => (await get()).session(),
    preview: async (op) => (await get()).preview(op),
    execute: async (op) => (await get()).execute(op),
  };
}

export function signerFor(env: AgentEnv, m: MandateRow): Signer {
  if (m.params.signer === "agentic_wallet") return new AgenticWalletSigner(remoteBaw(env, m.owner));
  return lazySigner("altana", () => altanaSigner(env, m.owner));
}

/** Hourly candles, shared by every mandate on the same pool through the Cache API (15 min). */
async function candles(a: StreamAsset, fetchImpl: typeof fetch): Promise<Candle[]> {
  const key = new Request(`https://cache.rivrwa.internal/candles/${a.pool}`);
  const hit = await caches.default.match(key);
  if (hit) return (await hit.json()) as Candle[];
  const data = fillGaps(await fetchOhlcvHistory(a.pool, a.token, { pages: 1, fetchImpl }), 3600); // retries 429s
  await caches.default.put(key, new Response(JSON.stringify(data), { headers: { "cache-control": "max-age=900" } }));
  return data;
}

export function depsFor(env: AgentEnv, m: MandateRow, log: (l: string) => void = console.log): Deps {
  const rpc = rpcOpts(env);
  return {
    signer: signerFor(env, m),
    store: d1Store(env.DB, m.id, env.RIVER_KV),
    now: Date.now,
    log: (l) => log(`[${m.id}] ${l}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    candles: (a) => candles(a, egressFetch(env.BAW)),
    pool: (a) => poolState(a.pool, a, rpc),
    balance: (token, owner) => erc20Balance(token, owner, rpc),
    receipt: (tx) => getReceipt(tx, rpc),
  };
}

/**
 * One tick of a mandate. `at` runs a dry-run as of another time: a rehearsal of the entry tick before the window
 * opens (candles and the pool price stay live, only the clock moves).
 */
export async function runMandate(env: AgentEnv, m: MandateRow, mode: Mode, now = Date.now(), at?: number): Promise<TickOutcome | null> {
  const loaded = parseMandate(m.params, await loadRegistry(env));
  const deps = at === undefined ? depsFor(env, m) : { ...depsFor(env, m), now: () => at };
  if (mode === "live") {
    const s = await deps.store.load();
    const clock = clockState(now);
    const idle = !s.position && !s.pending && !s.exit && !s.halted;
    if (idle && (clock.phase === "open" || now < clock.window.start + SIGNAL_DEFAULTS.settleMs)) return null; // nothing to do yet
  }
  // A cron invocation has minutes, not hours: leave slow receipts to the next event.
  return tick({ ...loaded, mode, receiptTimeoutMs: 90_000 }, deps);
}

const NOTIFY: TickOutcome["kind"][] = ["entered", "exited", "halted"];

export async function runAll(env: AgentEnv, now = Date.now()): Promise<void> {
  const mandates = await activeMandates(env.DB);
  await Promise.all(mandates.map(async (m) => {
    let o: TickOutcome | null;
    try {
      o = await runMandate(env, m, "live", now);
    } catch (e) {
      o = { kind: "blocked", note: `error: ${(e as Error).message}` };
    }
    if (!o) return;
    await recordTick(env.DB, m.id, o);
    const state = await d1Store(env.DB, m.id).load();
    const urgent = o.kind === "blocked" && (state.position || state.exit);
    if (o.kind === "exited") {
      const [c] = await cyclesOf(env.DB, m.id, 1);
      await notifyOwner(env, m.owner, c ? cycleMessage(c) : escapeHtml(o.note));
    } else if (NOTIFY.includes(o.kind) || urgent) {
      await notifyOwner(env, m.owner, `<b>River · ${escapeHtml(m.asset)} · ${o.kind}</b>\n${escapeHtml(o.note)}`);
    }
  }));
}

/**
 * Hourly: touch every Agentic Wallet session so it never idles out, record its expiry for the dashboard, and
 * ask for a renewal (one tap in the Binance App) when the hard cap lands before the next window's exit.
 */
export async function keepAlive(env: AgentEnv, now = Date.now()): Promise<void> {
  const next = clockState(now).window;
  const nextExit = next.end - SIGNAL_DEFAULTS.exitBufferMs;
  await Promise.all((await allBawSessions(env.DB)).map(async (row) => {
    try {
      const s = await new AgenticWalletSigner(remoteBaw(env, row.owner)).session();
      await setBawExpiry(env.DB, row.owner, s.idleExpiresAt ?? null, s.connected ? s.expiresAt : null);
      const lapsing = !s.connected || s.expiresAt - 30 * 60_000 < nextExit;
      const quiet = row.remindedAt && now - row.remindedAt < 20 * 3_600_000;
      if (lapsing && !quiet && next.start - now < 3 * 86_400_000) {
        const when = new Date(next.start).toUTCString().replace(":00 GMT", " UTC");
        await notifyOwner(env, row.owner, s.connected
          ? `<b>Renew River's Binance pass</b>\nYour Agentic Wallet session ends before the next closed window (${escapeHtml(when)}) is over. Renew it with one tap: ${escapeHtml(env.APP_URL ?? "")}/connect/binance`
          : `<b>River is disconnected from your Agentic Wallet</b>\nConnect again before ${escapeHtml(when)} so River can run this window: ${escapeHtml(env.APP_URL ?? "")}/connect/binance`);
        await markReminded(env.DB, row.owner, now);
      }
    } catch (e) {
      console.log(`keepalive ${row.owner}: ${(e as Error).message}`);
    }
  }));
}
