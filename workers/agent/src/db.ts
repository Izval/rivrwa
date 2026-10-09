// db.ts — D1 access for the agent Worker: mandates, the runner's state (the same AgentState the CLI keeps in a
// file), cycle records, recent tick outcomes for the dashboard, and the sealed signer sessions.

import type { MandateFile } from "../../../agent/src/mandate.ts";
import { emptyState, type AgentState, type CycleRecord, type Store } from "../../../agent/src/store.ts";
import type { TickOutcome } from "../../../agent/src/runner.ts";

export interface MandateRow {
  id: string;
  owner: string;
  asset: string;
  params: MandateFile;
  status: "active" | "paused";
  updatedAt: number;
}

interface RawMandate { id: string; owner: string; asset: string; params: string; status: "active" | "paused"; updated_at: number }
const toMandate = (r: RawMandate): MandateRow => ({ id: r.id, owner: r.owner, asset: r.asset, params: JSON.parse(r.params), status: r.status, updatedAt: r.updated_at });

export const mandateId = (owner: string, asset: string) => `${owner.toLowerCase()}:${asset.toUpperCase()}`;

export async function activeMandates(db: D1Database): Promise<MandateRow[]> {
  const { results } = await db.prepare("SELECT * FROM mandates WHERE status = 'active'").all<RawMandate>();
  return results.map(toMandate);
}

export async function mandatesOf(db: D1Database, owner: string): Promise<MandateRow[]> {
  const { results } = await db.prepare("SELECT * FROM mandates WHERE owner = ?").bind(owner).all<RawMandate>();
  return results.map(toMandate);
}

export async function putMandate(db: D1Database, f: MandateFile, status: "active" | "paused", now = Date.now()): Promise<string> {
  const id = mandateId(f.owner, f.asset);
  await db.prepare(
    `INSERT INTO mandates (id, owner, asset, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET params = excluded.params, status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(id, f.owner.toLowerCase(), f.asset.toUpperCase(), JSON.stringify(f), status, now, now).run();
  return id;
}

export async function setMandateStatus(db: D1Database, id: string, status: "active" | "paused") {
  await db.prepare("UPDATE mandates SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id).run();
}

/** The public ledger behind `get_cycle_report` and the transparency page: the last 50 closed cycles of every
 * mandate, owner shortened. Everything in it is already public on BSC (the txs are the proof). */
export const PUBLIC_CYCLES_KEY = "public:cycles";
export async function publishCycle(kv: KVNamespace, rec: CycleRecord) {
  const prev = (await kv.get<CycleRecord[]>(PUBLIC_CYCLES_KEY, "json")) ?? [];
  const pub = { ...rec, owner: `${rec.owner.slice(0, 6)}…${rec.owner.slice(-4)}` };
  await kv.put(PUBLIC_CYCLES_KEY, JSON.stringify([pub, ...prev.filter((c) => c.txs.remove !== rec.txs.remove)].slice(0, 50)));
}

/** The runner's Store over D1, one row per mandate. With `kv`, closed cycles also go to the public ledger. */
export function d1Store(db: D1Database, mandate: string, kv?: KVNamespace): Store {
  return {
    load: async () => {
      const r = await db.prepare("SELECT state FROM agent_state WHERE mandate_id = ?").bind(mandate).first<{ state: string }>();
      return r ? { ...emptyState(), ...(JSON.parse(r.state) as AgentState) } : emptyState();
    },
    save: async (s) => {
      await db.prepare(
        `INSERT INTO agent_state (mandate_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (mandate_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      ).bind(mandate, JSON.stringify(s), Date.now()).run();
    },
    appendCycle: async (rec: CycleRecord) => {
      await db.prepare("INSERT INTO cycles (mandate_id, closed_at, record) VALUES (?, ?, ?)").bind(mandate, Date.parse(rec.closedAt), JSON.stringify(rec)).run();
      if (kv) await publishCycle(kv, rec).catch((e) => console.warn(`publish cycle: ${(e as Error).message}`));
    },
  };
}

export async function cyclesOf(db: D1Database, mandate: string, limit = 50): Promise<CycleRecord[]> {
  const { results } = await db.prepare("SELECT record FROM cycles WHERE mandate_id = ? ORDER BY closed_at DESC LIMIT ?").bind(mandate, limit).all<{ record: string }>();
  return results.map((r) => JSON.parse(r.record));
}

/** Keep the last 100 outcomes per mandate: enough for the dashboard's activity feed. */
export async function recordTick(db: D1Database, mandate: string, o: TickOutcome, at = Date.now()) {
  await db.batch([
    db.prepare("INSERT INTO ticks (mandate_id, at, kind, note) VALUES (?, ?, ?, ?)").bind(mandate, at, o.kind, o.note),
    db.prepare("DELETE FROM ticks WHERE mandate_id = ? AND id NOT IN (SELECT id FROM ticks WHERE mandate_id = ? ORDER BY at DESC LIMIT 100)").bind(mandate, mandate),
  ]);
}

export async function recentTicks(db: D1Database, mandate: string, limit = 30) {
  const { results } = await db.prepare("SELECT at, kind, note FROM ticks WHERE mandate_id = ? ORDER BY at DESC LIMIT ?").bind(mandate, limit).all<{ at: number; kind: string; note: string }>();
  return results;
}

/** Rehearsals are dry-runs recorded with this prefix, so the checklist can find the last one. */
export const REHEARSAL = "rehearsal · ";

export async function lastRehearsal(db: D1Database, mandate: string) {
  return db.prepare("SELECT at, kind, note FROM ticks WHERE mandate_id = ? AND note LIKE ? ORDER BY at DESC LIMIT 1")
    .bind(mandate, `${REHEARSAL}%`).first<{ at: number; kind: string; note: string }>();
}

/** Clears a halt (the CLI's `resume`). Nothing else in the state changes. */
/** "Leave the pool now": marks an exit in progress, which the next tick (cron, every 5 min) carries out before any
 * new plan. False when there is no position, or an exit is already under way. */
export async function requestExit(db: D1Database, mandate: string, now = Date.now()) {
  const store = d1Store(db, mandate);
  const s = await store.load();
  if (!s.position || s.exit) return false;
  await store.save({ ...s, exit: { reason: "manual", startedAt: now, gasBnb: 0 } });
  return true;
}

export async function clearHalt(db: D1Database, mandate: string) {
  const store = d1Store(db, mandate);
  const s = await store.load();
  if (!s.halted) return false;
  await store.save({ ...s, halted: null });
  return true;
}

// --- users -------------------------------------------------------------------------------------------------

export interface UserRow { address: string; kind: "agentic_wallet" | "altana"; telegramChatId: string | null }

export async function getUser(db: D1Database, address: string): Promise<UserRow | null> {
  const r = await db.prepare("SELECT address, kind, telegram_chat_id FROM users WHERE address = ?").bind(address).first<{ address: string; kind: UserRow["kind"]; telegram_chat_id: string | null }>();
  return r ? { address: r.address, kind: r.kind, telegramChatId: r.telegram_chat_id } : null;
}

export async function upsertUser(db: D1Database, address: string, kind: UserRow["kind"]) {
  await db.prepare("INSERT INTO users (address, kind, created_at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET kind = excluded.kind")
    .bind(address, kind, Date.now()).run();
}

export async function setTelegram(db: D1Database, address: string, chatId: string) {
  await db.prepare("UPDATE users SET telegram_chat_id = ? WHERE address = ?").bind(chatId, address).run();
}

// --- flow A sessions -----------------------------------------------------------------------------------------

export interface BawSessionRow { owner: string; sealed: string; salt: string; expiresAt: number | null; maxAt: number | null; remindedAt: number | null }

export async function getBawSession(db: D1Database, owner: string): Promise<BawSessionRow | null> {
  const r = await db.prepare("SELECT * FROM baw_sessions WHERE owner = ?").bind(owner).first<{ owner: string; sealed: string; salt: string; expires_at: number | null; max_at: number | null; reminded_at: number | null }>();
  return r ? { owner: r.owner, sealed: r.sealed, salt: r.salt, expiresAt: r.expires_at, maxAt: r.max_at, remindedAt: r.reminded_at } : null;
}

export async function allBawSessions(db: D1Database): Promise<BawSessionRow[]> {
  const { results } = await db.prepare("SELECT owner FROM baw_sessions").all<{ owner: string }>();
  return (await Promise.all(results.map((r) => getBawSession(db, r.owner)))).filter((x): x is BawSessionRow => !!x);
}

export async function putBawSession(db: D1Database, owner: string, sealed: string, salt: string) {
  await db.prepare(
    `INSERT INTO baw_sessions (owner, sealed, salt, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner) DO UPDATE SET sealed = excluded.sealed, salt = excluded.salt, updated_at = excluded.updated_at, reminded_at = NULL`,
  ).bind(owner, sealed, salt, Date.now()).run();
}

export async function updateBawSealed(db: D1Database, owner: string, sealed: string) {
  await db.prepare("UPDATE baw_sessions SET sealed = ?, updated_at = ? WHERE owner = ?").bind(sealed, Date.now(), owner).run();
}

export async function setBawExpiry(db: D1Database, owner: string, expiresAt: number | null, maxAt: number | null) {
  await db.prepare("UPDATE baw_sessions SET expires_at = ?, max_at = ?, updated_at = ? WHERE owner = ?").bind(expiresAt, maxAt, Date.now(), owner).run();
}

export async function markReminded(db: D1Database, owner: string, at = Date.now()) {
  await db.prepare("UPDATE baw_sessions SET reminded_at = ? WHERE owner = ?").bind(at, owner).run();
}

export async function deleteBawSession(db: D1Database, owner: string) {
  await db.prepare("DELETE FROM baw_sessions WHERE owner = ?").bind(owner).run();
}

// --- flow B accounts ---------------------------------------------------------------------------------------

export interface AltanaRow {
  owner: string; credentialId: string; passkeyPubkey: string; rpId: string; state: "draft" | "ready" | "revoked";
  sealedKey: string | null; sessionAddress: string | null; serialized: string | null; expiry: number | null; grantTx: string | null;
  pendingSealed: string | null; pendingAddress: string | null; pendingPubkey: string | null; remindedAt: number | null;
}
interface RawAltana {
  owner: string; credential_id: string; passkey_pubkey: string; rp_id: string; state: AltanaRow["state"]; sealed_key: string | null;
  session_address: string | null; serialized: string | null; expiry: number | null; grant_tx: string | null; pending_sealed: string | null;
  pending_address: string | null; pending_pubkey: string | null; reminded_at: number | null;
}
const toAltana = (r: RawAltana): AltanaRow => ({
  owner: r.owner, credentialId: r.credential_id, passkeyPubkey: r.passkey_pubkey, rpId: r.rp_id, state: r.state, sealedKey: r.sealed_key,
  sessionAddress: r.session_address, serialized: r.serialized, expiry: r.expiry, grantTx: r.grant_tx, pendingSealed: r.pending_sealed,
  pendingAddress: r.pending_address, pendingPubkey: r.pending_pubkey, remindedAt: r.reminded_at,
});

export async function getAltana(db: D1Database, owner: string): Promise<AltanaRow | null> {
  const r = await db.prepare("SELECT * FROM altana_accounts WHERE owner = ?").bind(owner).first<RawAltana>();
  return r ? toAltana(r) : null;
}

export async function altanaByCredential(db: D1Database, credentialId: string): Promise<AltanaRow | null> {
  const r = await db.prepare("SELECT * FROM altana_accounts WHERE credential_id = ? AND state != 'draft'").bind(credentialId).first<RawAltana>();
  return r ? toAltana(r) : null;
}

export async function readyAltana(db: D1Database): Promise<AltanaRow[]> {
  const { results } = await db.prepare("SELECT * FROM altana_accounts WHERE state = 'ready'").all<RawAltana>();
  return results.map(toAltana);
}

/** A new account's draft, or a renewal's pending key on an existing one (its current session stays usable). */
export async function putAltanaPending(db: D1Database, p: {
  owner: string; credentialId: string; passkeyPubkey: string; rpId: string; sealed: string; address: string; pubkey: string;
}, now = Date.now()) {
  await db.prepare(
    `INSERT INTO altana_accounts (owner, credential_id, passkey_pubkey, rp_id, state, pending_sealed, pending_address, pending_pubkey, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
     ON CONFLICT (owner) DO UPDATE SET pending_sealed = excluded.pending_sealed, pending_address = excluded.pending_address,
       pending_pubkey = excluded.pending_pubkey, updated_at = excluded.updated_at,
       credential_id = CASE WHEN altana_accounts.state = 'draft' THEN excluded.credential_id ELSE altana_accounts.credential_id END,
       passkey_pubkey = CASE WHEN altana_accounts.state = 'draft' THEN excluded.passkey_pubkey ELSE altana_accounts.passkey_pubkey END,
       rp_id = CASE WHEN altana_accounts.state = 'draft' THEN excluded.rp_id ELSE altana_accounts.rp_id END`,
  ).bind(p.owner, p.credentialId, p.passkeyPubkey, p.rpId, p.sealed, p.address, p.pubkey, now, now).run();
}

/** The pending key becomes the session River signs with. */
export async function promoteAltana(db: D1Database, owner: string, s: { serialized: string; expiry: number; grantTx: string | null }, now = Date.now()) {
  await db.prepare(
    `UPDATE altana_accounts SET state = 'ready', sealed_key = pending_sealed, session_address = pending_address, serialized = ?, expiry = ?,
       grant_tx = ?, pending_sealed = NULL, pending_address = NULL, pending_pubkey = NULL, reminded_at = NULL, updated_at = ? WHERE owner = ?`,
  ).bind(s.serialized, s.expiry, s.grantTx, now, owner).run();
}

/** River forgets the session key (after an on-chain revoke, or instead of one). It cannot sign again. */
export async function revokeAltana(db: D1Database, owner: string, now = Date.now()) {
  await db.prepare(
    `UPDATE altana_accounts SET state = 'revoked', sealed_key = NULL, pending_sealed = NULL, pending_address = NULL, pending_pubkey = NULL,
       updated_at = ? WHERE owner = ?`,
  ).bind(now, owner).run();
}

export async function markAltanaReminded(db: D1Database, owner: string, at = Date.now()) {
  await db.prepare("UPDATE altana_accounts SET reminded_at = ? WHERE owner = ?").bind(at, owner).run();
}

export async function putChallenge(db: D1Database, id: string, challenge: string, now = Date.now()) {
  await db.batch([
    db.prepare("DELETE FROM altana_challenges WHERE created_at < ?").bind(now - 5 * 60_000),
    db.prepare("INSERT INTO altana_challenges (id, challenge, created_at) VALUES (?, ?, ?)").bind(id, challenge, now),
  ]);
}

/** Single use: the challenge is deleted as it is read. Null if unknown or older than 5 minutes. */
export async function takeChallenge(db: D1Database, id: string, now = Date.now()): Promise<string | null> {
  const r = await db.prepare("DELETE FROM altana_challenges WHERE id = ? RETURNING challenge, created_at").bind(id).first<{ challenge: string; created_at: number }>();
  return r && now - r.created_at < 5 * 60_000 ? r.challenge : null;
}
