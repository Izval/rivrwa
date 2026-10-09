// connect.altana.api.ts — the JSON steps of the Altana wizard (connect.altana.tsx), called with fetch between passkey
// prompts. `draft` gets River's session key (public half) and binds this browser to the account; `granted` turns the
// on-chain grant into a signed-in session, only for that browser; `challenge` + `login` sign a returning user in
// with their passkey.

import type { Route } from "./+types/connect.altana.api";
import { AgentError, altanaChallenge, altanaDraft, altanaGranted, altanaLogin } from "../lib/agent.server.ts";
import { altanaCookie, getOwner, signIn } from "../lib/session.server.ts";

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function action({ request }: Route.ActionArgs) {
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (b.intent) {
      case "draft": {
        const owner = await getOwner(request);
        const account = String(b.account ?? "").toLowerCase();
        const r = await altanaDraft(
          { account, credentialId: String(b.credentialId ?? ""), passkeyPubkey: String(b.passkeyPubkey ?? ""), rpId: new URL(request.url).hostname },
          owner === account ? owner : undefined,
        );
        return Response.json(r, { headers: { "set-cookie": await altanaCookie().serialize(account) } });
      }
      case "granted": {
        const account = String(b.account ?? "").toLowerCase();
        if ((await altanaCookie().parse(request.headers.get("cookie"))) !== account) return fail(403, "start the setup again from this browser");
        const r = await altanaGranted({ account, serialized: b.serialized, grantTx: typeof b.grantTx === "string" ? b.grantTx : null });
        const headers = new Headers();
        headers.append("set-cookie", await signIn(request, r.owner));
        headers.append("set-cookie", await altanaCookie().serialize("", { maxAge: 0 }));
        return Response.json(r, { headers });
      }
      case "challenge":
        return Response.json(await altanaChallenge());
      case "login": {
        const r = await altanaLogin({ id: String(b.id ?? ""), assertion: b.assertion, origin: new URL(request.url).origin });
        return Response.json(r, { headers: { "set-cookie": await signIn(request, r.owner) } });
      }
      default:
        return fail(400, "unknown step");
    }
  } catch (e) {
    return e instanceof AgentError ? fail(e.status, e.message) : fail(502, `River's agent did not answer (${(e as Error).message})`);
  }
}
