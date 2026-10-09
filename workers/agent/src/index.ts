// River agent Worker. Private: the app reaches it through a service binding and must send INTERNAL_KEY; the
// app has already authenticated the user and passes the account (the signing wallet) in x-river-owner.
//
//   POST /baw/pair                     start a Binance Agentic Wallet sign-in → pairing code + link
//   GET  /baw/pair/:id                 poll it; on success the Agentic Wallet address is the account
//   POST /baw/disconnect               sign out and forget the session
//   GET  /me                           account, mandates (+ state, recent ticks, cycles), session expiry
//   PUT  /mandate                      create/update the mandate for an asset (validated like the CLI's)
//   POST /mandate/:asset/status        {status: active|paused}
//   POST /mandate/:asset/preview       {mode: status|dry-run, rehearse?} → what the next tick would do, nothing sent;
//                                      rehearse = dry-run of the entry tick of the next window (recorded in ticks)
//   GET  /mandate/:asset/preflight     checklist for the next window (preflight.ts)
//   POST /mandate/:asset/resume        clear a halt once its cause is fixed
//   POST /telegram/link                → t.me deep link that binds a chat to the account
//   POST /altana/draft                 {account, credentialId, passkeyPubkey, rpId} → River's pending session key (public)
//   POST /altana/granted               {account, serialized, grantTx} → checked on-chain; the account becomes a River account
//   POST /altana/login/challenge       → {id, challenge}
//   POST /altana/login                 {id, assertion, origin} → {owner} when the passkey controls a River account
//   POST /altana/revoke                River forgets its session key and pauses the account's mandates
//   POST /telegram/webhook             Telegram updates, forwarded by the app

import type { MandateFile } from "../../../agent/src/mandate.ts";
import { parseMandate } from "../../../agent/src/mandate.ts";
import { AgenticWalletSigner } from "../../../agent/src/agentic-wallet.ts";
import { BawContainer, pollPairing, remoteBaw, startPairing } from "./baw.ts";
import { keepAlive, runAll, runMandate, signerFor, type AgentEnv } from "./cycle.ts";
import { rpcOpts } from "./egress.ts";
import {
  clearHalt, requestExit, cyclesOf, d1Store, deleteBawSession, getBawSession, getUser, lastRehearsal, mandateId, mandatesOf, putMandate, recentTicks,
  recordTick, REHEARSAL, setBawExpiry, setMandateStatus, type MandateRow,
} from "./db.ts";
import { nextWindow, preflightChecks, walletFacts } from "./preflight.ts";
import { handleUpdate, linkToken } from "./telegram.ts";
import { altanaView, altanaWatch, draft, granted, HttpError, login, loginChallenge, revoke } from "./altana-account.ts";
import { loadRegistry } from "./registry.ts";
import { clockState } from "../../../packages/core/src/index.ts";

export { BawContainer };

interface Env extends AgentEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function refreshBawExpiry(env: Env, owner: string) {
  const s = await new AgenticWalletSigner(remoteBaw(env, owner)).session();
  await setBawExpiry(env.DB, owner, s.idleExpiresAt ?? null, s.connected ? s.expiresAt : null);
  return s;
}

async function me(env: Env, owner: string) {
  const user = await getUser(env.DB, owner);
  if (!user) return null;
  const mandates = await Promise.all((await mandatesOf(env.DB, owner)).map(async (m) => ({
    ...m,
    state: await d1Store(env.DB, m.id).load(),
    ticks: await recentTicks(env.DB, m.id),
    cycles: await cyclesOf(env.DB, m.id),
  })));
  const baw = user.kind === "agentic_wallet" ? await getBawSession(env.DB, owner) : null;
  const altana = user.kind === "altana" ? await altanaView(env, owner) : null;
  const session = baw ? { connected: true, expiresAt: baw.maxAt, idleExpiresAt: baw.expiresAt }
    : altana ? { connected: altana.state === "ready" && (altana.expiresAt ?? 0) > Date.now(), expiresAt: altana.expiresAt }
    : { connected: false };
  return { user: { address: user.address, kind: user.kind, telegram: !!user.telegramChatId }, session, altana, mandates };
}

async function preflight(env: Env, m: MandateRow, now = Date.now()) {
  const { mandate, asset } = parseMandate(m.params, await loadRegistry(env));
  const [user, state, rehearsal, session, wallet] = await Promise.all([
    getUser(env.DB, m.owner), d1Store(env.DB, m.id).load(), lastRehearsal(env.DB, m.id),
    signerFor(env, m).session().catch((e) => ({ connected: false, expiresAt: 0, warnings: [(e as Error).message] })),
    walletFacts(asset, m.owner, rpcOpts(env)),
  ]);
  return preflightChecks({
    now, ...nextWindow(now), session, asset, status: m.status, allocation: mandate.allocation, mandateExpiresAt: mandate.expiresAt,
    state, ...wallet, telegram: !!user?.telegramChatId,
    rehearsal: rehearsal ? { ...rehearsal, note: rehearsal.note.slice(REHEARSAL.length) } : null,
  });
}

/** A rehearsal runs the entry tick as of 10 minutes after the next window's entry time (now, if it is open). */
async function rehearse(env: Env, m: MandateRow, now = Date.now()) {
  const { entryAt } = nextWindow(now);
  const at = clockState(now).phase === "closed_window" && now >= entryAt ? now : entryAt + 10 * 60_000;
  let o;
  try {
    o = (await runMandate(env, m, "dry-run", now, at)) ?? { kind: "wait" as const, note: "nothing to do" };
  } catch (e) {
    o = { kind: "blocked" as const, note: `error: ${(e as Error).message}` };
  }
  await recordTick(env.DB, m.id, { kind: o.kind, note: REHEARSAL + o.note });
  return o;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.INTERNAL_KEY || req.headers.get("x-river-key") !== env.INTERNAL_KEY) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const owner = req.headers.get("x-river-owner")?.toLowerCase() || null;

    try {
      if (path === "/telegram/webhook" && req.method === "POST") {
        if (!env.TELEGRAM_WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
        await handleUpdate(env, await req.json());
        return json({ ok: true });
      }

      if (path === "/baw/pair" && req.method === "POST") return json(await startPairing(env));
      const pair = path.match(/^\/baw\/pair\/([0-9a-f]{24})$/);
      if (pair && req.method === "GET") {
        const st = await pollPairing(env, pair[1]);
        if (st.state === "success") await refreshBawExpiry(env, st.owner).catch(() => {});
        return json(st);
      }

      // Flow B sign-up and sign-in: before there is an account (owner is null, or a renewal by the signed-in owner).
      if (path === "/altana/draft" && req.method === "POST") return json(await draft(env, owner, await req.json()));
      if (path === "/altana/granted" && req.method === "POST") return json(await granted(env, await req.json()));
      if (path === "/altana/login/challenge" && req.method === "POST") return json(await loginChallenge(env));
      if (path === "/altana/login" && req.method === "POST") return json(await login(env, await req.json()));

      if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) return json({ error: "no account" }, 401);

      if (path === "/altana/revoke" && req.method === "POST") return json(await revoke(env, owner));

      if (path === "/me" && req.method === "GET") {
        const out = await me(env, owner);
        return out ? json(out) : json({ error: "unknown account" }, 404);
      }

      if (path === "/baw/disconnect" && req.method === "POST") {
        await remoteBaw(env, owner)(["auth", "signout", "--json"]).catch(() => "");
        await deleteBawSession(env.DB, owner);
        return json({ ok: true });
      }

      if (path === "/mandate" && req.method === "PUT") {
        const user = await getUser(env.DB, owner);
        if (!user) return json({ error: "connect a wallet first" }, 403);
        const b = (await req.json()) as Partial<MandateFile> & { status?: "active" | "paused" };
        const f: MandateFile = {
          owner, signer: user.kind, asset: String(b.asset ?? ""), allocation: Number(b.allocation), maxHalfWidth: Number(b.maxHalfWidth),
          exitOnDrift: Number(b.exitOnDrift), skipEvents: !!b.skipEvents, events: b.events ?? [], restoreShares: !!b.restoreShares,
          expiresAt: String(b.expiresAt ?? ""), slippageBps: b.slippageBps === undefined ? undefined : Number(b.slippageBps),
        };
        try {
          const { asset } = parseMandate(f, await loadRegistry(env));
          if (!asset.enabled) return json({ error: `${asset.symbol} is not enabled yet${asset.note ? ` (${asset.note})` : ""}` }, 400);
          f.asset = asset.symbol;
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
        const id = await putMandate(env.DB, f, b.status === "active" ? "active" : "paused");
        return json({ id });
      }

      const ms = path.match(/^\/mandate\/([A-Za-z0-9.]+)\/(status|preview|preflight|resume|exit)$/);
      if (ms && req.method === (ms[2] === "preflight" ? "GET" : "POST")) {
        const id = mandateId(owner, ms[1]);
        const m = (await mandatesOf(env.DB, owner)).find((x) => x.id === id);
        if (!m) return json({ error: "no mandate for that asset" }, 404);
        if (ms[2] === "preflight") return json(await preflight(env, m));
        if (ms[2] === "resume") return json({ resumed: await clearHalt(env.DB, id) });
        if (ms[2] === "exit") return json({ requested: await requestExit(env.DB, id) });
        const b = (await req.json().catch(() => ({}))) as { status?: string; mode?: string; rehearse?: boolean };
        if (ms[2] === "status") {
          if (b.status !== "active" && b.status !== "paused") return json({ error: "status must be active or paused" }, 400);
          await setMandateStatus(env.DB, id, b.status);
          return json({ ok: true });
        }
        if (b.rehearse) return json(await rehearse(env, m));
        const mode = b.mode === "dry-run" ? "dry-run" : "status";
        return json(await runMandate(env, m, mode));
      }

      if (path === "/telegram/link" && req.method === "POST") return json({ url: await linkToken(env, owner) });

      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: (e as Error).message }, 502);
    }
  },

  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await runAll(env, ctrl.scheduledTime);
      if (new Date(ctrl.scheduledTime).getUTCMinutes() < 5) {
        await keepAlive(env, ctrl.scheduledTime);
        await altanaWatch(env, ctrl.scheduledTime);
      }
    })());
  },
};
