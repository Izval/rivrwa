// logout.ts — end the River session in this browser. The Binance session stays with the agent; that is "Disconnect".

import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { signOut } from "../lib/session.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return redirect("/", { headers: { "set-cookie": await signOut(request) } });
}

export const loader = () => redirect("/");
