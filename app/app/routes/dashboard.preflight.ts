// dashboard.preflight.ts — the "ready for the next window?" checklist of one mandate, loaded by its card after the
// dashboard renders. It reads the signer's session and the wallet on-chain (a few seconds), so it stays out of the
// dashboard's own loader.

import { data } from "react-router";
import type { Route } from "./+types/dashboard.preflight";
import { AgentError, preflight, type Preflight } from "../lib/agent.server.ts";
import { requireOwner } from "../lib/session.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const owner = await requireOwner(request);
  try {
    return data<{ preflight: Preflight | null; error: string | null }>({ preflight: await preflight(owner, params.asset), error: null });
  } catch (e) {
    const msg = e instanceof AgentError ? e.message : (e as Error).message;
    return data({ preflight: null, error: `The checklist is unavailable (${msg}).` });
  }
}
