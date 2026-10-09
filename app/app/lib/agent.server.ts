// agent.server.ts — the app's client for rivrwa-agent. Every call carries INTERNAL_KEY; calls on behalf of a person
// also carry their account (the signing wallet) in x-river-owner, which only the app may assert: it comes from the
// signed session cookie, never from the browser. Route list: workers/agent/src/index.ts.

import { env } from "cloudflare:workers";
import type { MandateFile } from "../../../agent/src/mandate.ts";
import type { AgentState, CycleRecord } from "../../../agent/src/store.ts";
import type { TickOutcome } from "../../../agent/src/runner.ts";
import type { MandateRow } from "../../../workers/agent/src/db.ts";
import type { PairingStart, PairingState } from "../../../workers/agent/src/baw.ts";
import type { Preflight, PreflightItem } from "../../../workers/agent/src/preflight.ts";
import { callWorker } from "./binding.server.ts";

export type { AgentState, CycleRecord, MandateFile, MandateRow, PairingStart, PairingState, Preflight, PreflightItem, TickOutcome };

export interface Tick { at: number; kind: string; note: string }
export type MandateView = MandateRow & { state: AgentState; ticks: Tick[]; cycles: CycleRecord[] };

export interface AltanaView {
  account: string;
  state: "draft" | "ready" | "revoked";
  expiresAt: number | null;
  grantTx: string | null;
  passkey: { id: string; publicKey: string; rpId: string };
  sessionAddress: string | null;
  /** River's current session key (public), which the passkey can revoke on-chain. */
  sessionPubkey: string | null;
}

export interface Me {
  user: { address: string; kind: "agentic_wallet" | "altana"; telegram: boolean };
  /**
   * Flow A: expiresAt is the sign-in's hard cap and idleExpiresAt the 48h idle sign-out (null until read).
   * Flow B: expiresAt is the Altana session's end.
   */
  session: { connected: boolean; expiresAt?: number | null; idleExpiresAt?: number | null };
  altana?: AltanaView | null;
  mandates: MandateView[];
}

export class AgentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function agent<T>(path: string, opts: { method?: string; owner?: string; body?: unknown; headers?: HeadersInit; raw?: BodyInit } = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("x-river-key", env.INTERNAL_KEY);
  if (opts.owner) headers.set("x-river-owner", opts.owner);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const res = await callWorker(env.AGENT, env.AGENT_URL, path, {
    method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET"),
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new AgentError(res.status, data.error ?? `agent answered ${res.status}`);
  return data;
}

export const startPairing = () => agent<PairingStart>("/baw/pair", { method: "POST" });
export const pollPairing = (id: string) => agent<PairingState>(`/baw/pair/${id}`);

/** null when the account has no user row (e.g. D1 was reset); the caller logs the person out. */
export async function me(owner: string): Promise<Me | null> {
  try {
    return await agent<Me>("/me", { owner });
  } catch (e) {
    if (e instanceof AgentError && e.status === 404) return null;
    throw e;
  }
}

export type MandateInput = Omit<MandateFile, "owner" | "signer"> & { status?: "active" | "paused" };
export const putMandate = (owner: string, m: MandateInput) => agent<{ id: string }>("/mandate", { method: "PUT", owner, body: m });
export const setStatus = (owner: string, asset: string, status: "active" | "paused") =>
  agent<{ ok: true }>(`/mandate/${asset}/status`, { owner, body: { status } });
export const preview = (owner: string, asset: string) => agent<TickOutcome>(`/mandate/${asset}/preview`, { owner, body: { mode: "dry-run" } });
/** Dry-run of the next window's entry tick through the signer's own preview; recorded for the checklist. */
export const rehearse = (owner: string, asset: string) => agent<TickOutcome>(`/mandate/${asset}/preview`, { owner, body: { rehearse: true } });
export const preflight = (owner: string, asset: string) => agent<Preflight>(`/mandate/${asset}/preflight`, { owner });
export const resume = (owner: string, asset: string) => agent<{ resumed: boolean }>(`/mandate/${asset}/resume`, { owner, body: {} });
export const requestExit = (owner: string, asset: string) => agent<{ requested: boolean }>(`/mandate/${asset}/exit`, { owner, body: {} });
export const telegramLink = (owner: string) => agent<{ url: string }>("/telegram/link", { method: "POST", owner });
export const disconnect = (owner: string) => agent<{ ok: true }>("/baw/disconnect", { method: "POST", owner });

// Flow B. `owner` is passed only for a renewal by the signed-in account.
export const altanaDraft = (b: { account: string; credentialId: string; passkeyPubkey: string; rpId: string }, owner?: string) =>
  agent<{ sessionAddress: string; sessionPubkey: string }>("/altana/draft", { owner, body: b });
export const altanaGranted = (b: { account: string; serialized: unknown; grantTx: string | null }) =>
  agent<{ owner: string; expiry: number }>("/altana/granted", { body: b });
export const altanaChallenge = () => agent<{ id: string; challenge: string }>("/altana/login/challenge", { method: "POST" });
export const altanaLogin = (b: { id: string; assertion: unknown; origin: string }) => agent<{ owner: string }>("/altana/login", { body: b });
export const altanaRevoke = (owner: string) => agent<{ ok: true }>("/altana/revoke", { owner, body: {} });

/** Pass a Telegram update through untouched; the agent checks Telegram's secret header itself. */
export function forwardTelegram(body: string, secret: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-telegram-bot-api-secret-token"] = secret;
  return agent<{ ok: true }>("/telegram/webhook", { method: "POST", headers, raw: body });
}
