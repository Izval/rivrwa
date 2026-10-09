// baw.ts — flow A from the Worker: the Binance Agentic Wallet CLI running in a Cloudflare Container.
//
// One container instance per user (and one per pending sign-in), started on demand and asleep otherwise. The
// user's session file lives only in D1, sealed; each call unseals it, hands it to the container with the
// user's BINANCE_INSTANCE_ID, and stores back whatever baw left (baw deletes the file when Binance ends the
// session). The container keeps nothing between calls.

import { Container, getContainer } from "@cloudflare/containers";
import type { BawRunner } from "../../../agent/src/agentic-wallet.ts";
import { instanceIdFor, randomId, seal, unseal } from "./crypto.ts";
import { deleteBawSession, getBawSession, putBawSession, updateBawSealed, upsertUser } from "./db.ts";

export class BawContainer extends Container {
  defaultPort = 8080;
  // A pending sign-in waits up to 5 min for the App confirmation; a cycle's calls come in bursts.
  sleepAfter = "10m";
}

export interface BawEnv {
  DB: D1Database;
  BAW: DurableObjectNamespace<BawContainer>;
  RIVER_MASTER_KEY: string;
}

const PAIRING_TTL_MS = 6 * 60_000;

async function call<T>(stub: DurableObjectStub<BawContainer>, path: string, body?: unknown): Promise<T> {
  const r = await stub.fetch(new Request(`http://baw${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
  if (!r.ok) throw new Error(`baw container ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

const userStub = (env: BawEnv, owner: string) => getContainer(env.BAW, `u-${owner}`);
const pairingStub = (env: BawEnv, id: string) => getContainer(env.BAW, `p-${id}`);

/** The BawRunner for one owner. Without a stored session, `wallet status` answers UNCONNECTED like baw would. */
export function remoteBaw(env: BawEnv, owner: string): BawRunner {
  return async (args) => {
    const row = await getBawSession(env.DB, owner);
    if (!row) {
      return args[0] === "wallet" && args[1] === "status"
        ? JSON.stringify({ success: true, data: { status: "UNCONNECTED" } })
        : JSON.stringify({ success: false, error: { code: "NO_SESSION", name: "NOT_LOGGED_IN", message: "No Agentic Wallet session: connect it in River" } });
    }
    const session = await unseal(env.RIVER_MASTER_KEY, row.sealed);
    const instanceId = await instanceIdFor(env.RIVER_MASTER_KEY, row.salt);
    const out = await call<{ stdout: string; session: string | null }>(userStub(env, owner), "/run", { instanceId, session, args });
    if (out.session === null) await deleteBawSession(env.DB, owner);
    else if (out.session !== session) await updateBawSealed(env.DB, owner, await seal(env.RIVER_MASTER_KEY, out.session));
    return out.stdout;
  };
}

export interface PairingStart { pairingId: string; urlForWeb: string; pairingCode: string; expireAt: number }

/** Starts a Binance sign-in: the user confirms `pairingCode` in the Binance App (or opens `urlForWeb` on the phone). */
export async function startPairing(env: BawEnv): Promise<PairingStart> {
  const id = randomId(12), salt = randomId(16);
  const out = await call<{ success: boolean; data?: { qrCodeId: string; urlForWeb: string; pairingCode: string; expireAt: string }; error?: { message?: string } }>(
    pairingStub(env, id), "/signin", { instanceId: await instanceIdFor(env.RIVER_MASTER_KEY, salt) });
  if (!out.success || !out.data?.qrCodeId) throw new Error(`Binance sign-in failed: ${out.error?.message ?? "no QR code"}`);
  await env.DB.prepare("INSERT INTO pairings (id, salt, state, created_at) VALUES (?, ?, 'pending', ?)").bind(id, salt, Date.now()).run();
  return { pairingId: id, urlForWeb: out.data.urlForWeb, pairingCode: out.data.pairingCode, expireAt: Number(out.data.expireAt) };
}

export type PairingState = { state: "pending" } | { state: "failed"; error: string } | { state: "success"; owner: string };

/**
 * Polls a sign-in. On success the Agentic Wallet's BSC address becomes the River account (owner): the user
 * proved control of it by confirming in the Binance App.
 */
export async function pollPairing(env: BawEnv, id: string): Promise<PairingState> {
  const row = await env.DB.prepare("SELECT salt, state, owner, created_at FROM pairings WHERE id = ?").bind(id)
    .first<{ salt: string; state: string; owner: string | null; created_at: number }>();
  if (!row) return { state: "failed", error: "unknown sign-in" };
  if (row.state === "success") return { state: "success", owner: row.owner! };
  if (row.state === "failed") return { state: "failed", error: "sign-in expired or rejected; start again" };

  const fail = async (error: string): Promise<PairingState> => {
    await env.DB.prepare("UPDATE pairings SET state = 'failed' WHERE id = ?").bind(id).run();
    return { state: "failed", error };
  };
  const stub = pairingStub(env, id);
  const st = await call<{ state: string; error?: string; session?: string | null }>(stub, "/signin");
  if (st.state === "failed") return fail(st.error ?? "sign-in rejected");
  if (st.state !== "success" || !st.session) {
    // "idle" means the container was recycled and lost the pending verify: the code cannot complete any more.
    if (st.state === "idle" || Date.now() - row.created_at > PAIRING_TTL_MS) return fail("sign-in expired; start again");
    return { state: "pending" };
  }

  const instanceId = await instanceIdFor(env.RIVER_MASTER_KEY, row.salt);
  const addr = await call<{ stdout: string; session: string | null }>(stub, "/run", { instanceId, session: st.session, args: ["wallet", "address", "--json"] });
  const parsed = JSON.parse(addr.stdout) as { success: boolean; data?: { addresses: { binanceChainId: string; address: string }[] } };
  const owner = parsed.data?.addresses.find((a) => a.binanceChainId === "56")?.address.toLowerCase();
  if (!owner) return fail("the Agentic Wallet has no BSC address");
  await putBawSession(env.DB, owner, await seal(env.RIVER_MASTER_KEY, addr.session ?? st.session), row.salt);
  await upsertUser(env.DB, owner, "agentic_wallet");
  await env.DB.prepare("UPDATE pairings SET state = 'success', owner = ? WHERE id = ?").bind(owner, id).run();
  return { state: "success", owner };
}
