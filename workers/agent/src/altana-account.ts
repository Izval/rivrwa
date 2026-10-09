// altana-account.ts — the life of a flow B account on River's side: the session key River makes for a grant, the
// grant's on-chain check that turns the account into a River account, the passkey sign-in, revocation, and the
// hourly watch that reminds before a session ends and pauses what can no longer run.
//
// Trust model. The browser creates the passkey and the account, and grants River's key with the passkey; the
// server never sees the passkey and the browser never sees River's key. A draft proves nothing. The grant is
// accepted only once the account contract itself lists River's pending key *and* the passkey the draft named, which
// only the account's admin could arrange. From then on that passkey can sign in (webauthn.ts).

import { binanceWeb3, rpc } from "../../../packages/core/src/index.ts";
import type { Signer } from "../../../agent/src/signer.ts";
import { AltanaSigner, RENEW_WARN_MS } from "./altana.ts";
import { accountKeys, keysInclude, newSessionKey, sendWithSession } from "./altana-sdk.ts";
import { randomId, seal, unseal } from "./crypto.ts";
import {
  d1Store, getAltana, altanaByCredential, mandatesOf, markAltanaReminded, promoteAltana, putAltanaPending, putChallenge, readyAltana,
  revokeAltana, setMandateStatus, takeChallenge, upsertUser,
} from "./db.ts";
import { egressFetch, rpcOpts } from "./egress.ts";
import { b64url, verifyAssertion, type Assertion } from "./webauthn.ts";
import { escapeHtml, notifyOwner } from "./telegram.ts";
import type { AgentEnv } from "./cycle.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ADDR = /^0x[0-9a-f]{40}$/;
/** Longest grant River accepts: 6 months and a margin. */
const MAX_SESSION_S = 190 * 86_400;

/** Flow B's signer for `owner`, built from the account row (the key is unsealed only to sign). */
export async function altanaSigner(env: AgentEnv, owner: string): Promise<Signer> {
  const row = await getAltana(env.DB, owner);
  if (!row) throw new Error("no Altana account for this owner");
  if (!env.BINANCE_WEB3_API_KEY || !env.BINANCE_WEB3_SECRET_KEY) throw new Error("BINANCE_WEB3_API_KEY / BINANCE_WEB3_SECRET_KEY are not set on the agent");
  const o = rpcOpts(env);
  return new AltanaSigner({
    account: owner,
    expiry: row.expiry ?? 0,
    revoked: row.state !== "ready" || !row.sealedKey || !row.serialized,
    build: binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW)),
    call: (to, data) => rpc<string>("eth_call", [{ from: owner, to, data }, "latest"], o),
    send: async (calls) => {
      const fresh = await getAltana(env.DB, owner); // a revoke between preview and send must win
      if (!fresh?.sealedKey || !fresh.serialized || fresh.state !== "ready") throw new Error("the Altana session was revoked");
      return sendWithSession(JSON.parse(fresh.serialized), (await unseal(env.RIVER_MASTER_KEY, fresh.sealedKey)) as `0x${string}`, calls, env.ALTANA_RPC_URL);
    },
  });
}

/**
 * Step 1 of a grant: River makes a session key for `account` and returns only its public half. A new account starts
 * as a draft; an existing one (a renewal) keeps its current session until the new grant is seen on-chain, and only
 * its signed-in owner may start one.
 */
export async function draft(env: AgentEnv, owner: string | null, b: { account?: string; credentialId?: string; passkeyPubkey?: string; rpId?: string }) {
  const account = String(b.account ?? "").toLowerCase();
  const passkeyPubkey = String(b.passkeyPubkey ?? "").toLowerCase();
  if (!ADDR.test(account)) throw new HttpError(400, "account must be a 0x address");
  if (!/^0x[0-9a-f]{128}$/.test(passkeyPubkey)) throw new HttpError(400, "passkeyPubkey must be the P-256 x ‖ y (64 bytes hex)");
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(String(b.credentialId ?? ""))) throw new HttpError(400, "credentialId must be base64url");
  if (!/^[a-z0-9.-]{1,253}$/.test(String(b.rpId ?? ""))) throw new HttpError(400, "rpId must be a host name");
  const row = await getAltana(env.DB, account);
  if (row && row.state !== "draft" && owner !== account) throw new HttpError(403, "sign in with this account's passkey to renew its session");
  const key = newSessionKey();
  await putAltanaPending(env.DB, {
    owner: account, credentialId: String(b.credentialId), passkeyPubkey, rpId: String(b.rpId),
    sealed: await seal(env.RIVER_MASTER_KEY, key.privateKey), address: key.address, pubkey: key.publicKey.toLowerCase(),
  });
  return { sessionAddress: key.address, sessionPubkey: key.publicKey };
}

/**
 * Step 2: the browser granted River's pending key with the passkey. Accepted only when the account contract lists
 * both that key and the draft's passkey; the session's expiry is taken from the chain, not from the browser.
 */
export async function granted(env: AgentEnv, b: { account?: string; serialized?: unknown; grantTx?: string }, nowS = Date.now() / 1000) {
  const account = String(b.account ?? "").toLowerCase();
  const row = ADDR.test(account) ? await getAltana(env.DB, account) : null;
  if (!row?.pendingAddress || !row.pendingPubkey) throw new HttpError(404, "no pending grant for this account");
  const ser = b.serialized as { walletAddress?: string; publicKey?: string; expiry?: number } | undefined;
  if (ser?.walletAddress?.toLowerCase() !== account || ser.publicKey?.toLowerCase() !== row.pendingPubkey)
    throw new HttpError(400, "the session does not match River's pending key");
  // Before its first intent lands the account has no code, and getKeys reverts: the grant is simply not there yet.
  const keys = await accountKeys(account, rpcOpts(env)).catch((e) => {
    if (/revert/i.test((e as Error).message)) throw new HttpError(409, "the account has no keys on-chain yet; wait for the grant to confirm");
    throw e;
  });
  const has = keysInclude(keys, { sessionAddress: row.pendingAddress, passkeyPubkey: row.passkeyPubkey }, nowS);
  if (!has.session) throw new HttpError(409, "the grant is not visible on-chain yet; try again in a few seconds");
  if (!has.passkey) throw new HttpError(403, "this passkey does not control the account");
  const k = keys.find((x) => x.publicKey.endsWith(row.pendingAddress!.slice(2)))!;
  const expiry = k.expiry || Number(ser.expiry ?? 0);
  if (!(expiry > nowS) || expiry - nowS > MAX_SESSION_S) throw new HttpError(400, "the session must end within about six months");
  const txHash = /^0x[0-9a-f]{64}$/i.test(String(b.grantTx ?? "")) ? String(b.grantTx) : null;
  await promoteAltana(env.DB, account, { serialized: JSON.stringify(ser), expiry, grantTx: txHash });
  await upsertUser(env.DB, account, "altana");
  return { owner: account, expiry };
}

export async function loginChallenge(env: AgentEnv) {
  const id = randomId(12), challenge = b64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  await putChallenge(env.DB, id, challenge);
  return { id, challenge };
}

/** A passkey assertion over River's challenge → the account it controls. `origin` is the app's own origin. */
export async function login(env: AgentEnv, b: { id?: string; assertion?: Assertion; origin?: string }) {
  const challenge = await takeChallenge(env.DB, String(b.id ?? ""));
  if (!challenge) throw new HttpError(400, "the sign-in expired; try again");
  const a = b.assertion;
  if (!a?.credentialId) throw new HttpError(400, "missing assertion");
  const row = await altanaByCredential(env.DB, a.credentialId);
  if (!row) throw new HttpError(404, "no River account uses this passkey");
  const origin = new URL(String(b.origin)).origin, rpId = new URL(origin).hostname;
  if (row.rpId !== rpId) throw new HttpError(403, `this passkey belongs to ${row.rpId}`);
  try {
    await verifyAssertion(a, row.passkeyPubkey, { challenge, origin, rpId });
  } catch (e) {
    throw new HttpError(403, `passkey check failed: ${(e as Error).message}`);
  }
  return { owner: row.owner };
}

/** River forgets its key and pauses the account's mandates. `onchain` only records that the passkey also revoked it. */
export async function revoke(env: AgentEnv, owner: string) {
  await revokeAltana(env.DB, owner);
  for (const m of await mandatesOf(env.DB, owner)) await setMandateStatus(env.DB, m.id, "paused");
  return { ok: true };
}

/** What the dashboard needs about the account (nothing secret: the passkey's public key and id, the session's expiry). */
export async function altanaView(env: AgentEnv, owner: string) {
  const row = await getAltana(env.DB, owner);
  if (!row) return null;
  return {
    account: row.owner, state: row.state, expiresAt: row.expiry ? row.expiry * 1000 : null, grantTx: row.grantTx,
    passkey: { id: row.credentialId, publicKey: row.passkeyPubkey, rpId: row.rpId }, sessionAddress: row.sessionAddress,
    sessionPubkey: row.serialized ? ((JSON.parse(row.serialized) as { publicKey?: string }).publicKey ?? null) : null,
  };
}

/**
 * Hourly: a reminder a week before a session ends (every 3 days) and again on its last day; once it has ended,
 * mandates with nothing in the pool are paused and the owner told. Mandates with a position stay active: the runner
 * already left before the expiry, or keeps reporting that it is blocked.
 */
export async function altanaWatch(env: AgentEnv, now = Date.now()) {
  for (const row of await readyAltana(env.DB)) {
    try {
      const end = (row.expiry ?? 0) * 1000, left = end - now, since = row.remindedAt ? now - row.remindedAt : Infinity;
      const link = `${env.APP_URL ?? ""}/connect/altana?renew=1`;
      const when = new Date(end).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      if (left <= 0) {
        if (row.remindedAt && row.remindedAt >= end) continue;
        let paused = 0;
        for (const m of await mandatesOf(env.DB, row.owner)) {
          const s = await d1Store(env.DB, m.id).load();
          if (m.status === "active" && !s.position && !s.pending && !s.exit) { await setMandateStatus(env.DB, m.id, "paused"); paused++; }
        }
        await notifyOwner(env, row.owner, `<b>River's Altana session ended</b> (${escapeHtml(when)}). ${paused} mandate(s) paused. Grant a new one: ${escapeHtml(link)}`);
        await markAltanaReminded(env.DB, row.owner, now);
      } else if ((left < RENEW_WARN_MS && since > 3 * 86_400_000) || (left < 86_400_000 && since > 20 * 3_600_000)) {
        await notifyOwner(env, row.owner, `<b>Renew River's Altana session</b>\nIt ends ${escapeHtml(when)}. One passkey tap renews it: ${escapeHtml(link)}`);
        await markAltanaReminded(env.DB, row.owner, now);
      }
    } catch (e) {
      console.log(`altana watch ${row.owner}: ${(e as Error).message}`);
    }
  }
}
