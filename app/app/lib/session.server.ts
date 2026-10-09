// session.server.ts — who is signed in. A person is their signing wallet's address, set in a signed, HttpOnly cookie
// only after the agent confirms a pairing that *this browser* started: the pairing id travels in its own short-lived
// signed cookie, because the agent's poll answers anyone who knows the id. An Altana grant is bound the same way
// (river_altana): the agent checks it on-chain, but only the browser that drafted it may sign in with it.

import { env } from "cloudflare:workers";
import { createCookie, createCookieSessionStorage, redirect } from "react-router";

const base = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };

let storage: ReturnType<typeof createCookieSessionStorage<{ owner: string }>> | null = null;
const sessions = () =>
  (storage ??= createCookieSessionStorage<{ owner: string }>({
    cookie: { name: "river_session", ...base, maxAge: 30 * 86400, secrets: [env.SESSION_SECRET] },
  }));

let pair: ReturnType<typeof createCookie> | null = null;
export const pairCookie = () => (pair ??= createCookie("river_pair", { ...base, maxAge: 10 * 60, secrets: [env.SESSION_SECRET] }));

/** The Altana account this browser is setting up: only this browser may turn its grant into a signed-in session. */
let altana: ReturnType<typeof createCookie> | null = null;
export const altanaCookie = () => (altana ??= createCookie("river_altana", { ...base, maxAge: 60 * 60, secrets: [env.SESSION_SECRET] }));

export async function getOwner(request: Request): Promise<string | null> {
  const s = await sessions().getSession(request.headers.get("cookie"));
  return s.get("owner") ?? null;
}

export async function requireOwner(request: Request): Promise<string> {
  const owner = await getOwner(request);
  if (!owner) throw redirect("/connect/binance");
  return owner;
}

/** Set-Cookie value that signs `owner` in. */
export async function signIn(request: Request, owner: string): Promise<string> {
  const s = await sessions().getSession(request.headers.get("cookie"));
  s.set("owner", owner.toLowerCase());
  return sessions().commitSession(s);
}

export async function signOut(request: Request): Promise<string> {
  return sessions().destroySession(await sessions().getSession(request.headers.get("cookie")));
}
