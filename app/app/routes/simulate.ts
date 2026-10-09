// simulate.ts — resource route the landing's simulator calls as its inputs change. It proxies rivrwa-api
// /v1/simulate, which rounds the size and caches, so typing in the amount field stays cheap.

import type { Route } from "./+types/simulate";
import { simulation } from "../lib/api.server.ts";
import { clampSize, type Competition } from "../lib/simulation.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const u = new URL(request.url);
  const x = ([1, 2, 4].includes(Number(u.searchParams.get("x"))) ? Number(u.searchParams.get("x")) : 1) as Competition;
  const sim = await simulation(u.searchParams.get("symbol") ?? "", clampSize(Number(u.searchParams.get("size"))), x);
  return Response.json(sim ? { sim, error: null } : { sim: null, error: "No replay for that stock yet." }, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
