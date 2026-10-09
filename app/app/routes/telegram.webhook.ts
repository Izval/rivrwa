// telegram.webhook.ts — Telegram's webhook lands on the public app and is passed to the private agent unchanged.
// The agent checks Telegram's secret header, so a forged update is rejected there (403), not here.

import type { Route } from "./+types/telegram.webhook";
import { AgentError, forwardTelegram } from "../lib/agent.server.ts";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  try {
    return Response.json(await forwardTelegram(await request.text(), request.headers.get("x-telegram-bot-api-secret-token")));
  } catch (e) {
    const status = e instanceof AgentError && e.status < 500 ? e.status : 502;
    return Response.json({ error: (e as Error).message }, { status });
  }
}

export const loader = () => Response.json({ error: "method not allowed" }, { status: 405 });
