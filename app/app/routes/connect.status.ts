// connect.status.ts — polled by /connect/binance. It only answers for the pairing this browser started (the id is
// in a signed cookie), and on success turns the Agentic Wallet address into a signed-in River session.

import { data } from "react-router";
import type { Route } from "./+types/connect.status";
import { pollPairing } from "../lib/agent.server.ts";
import { pairCookie, signIn } from "../lib/session.server.ts";

type Status = { state: "none" } | { state: "pending" } | { state: "failed"; error: string } | { state: "success" };

export async function loader({ request }: Route.LoaderArgs) {
  const id = await pairCookie().parse(request.headers.get("cookie"));
  if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return data<Status>({ state: "none" });
  const clear = await pairCookie().serialize("", { maxAge: 0 });
  let s;
  try {
    s = await pollPairing(id);
  } catch (e) {
    return data<Status>({ state: "failed", error: (e as Error).message }, { headers: { "set-cookie": clear } });
  }
  if (s.state === "pending") return data<Status>({ state: "pending" });
  if (s.state === "failed") return data<Status>({ state: "failed", error: s.error }, { headers: { "set-cookie": clear } });
  const headers = new Headers();
  headers.append("set-cookie", await signIn(request, s.owner));
  headers.append("set-cookie", clear);
  return data<Status>({ state: "success" }, { headers });
}
