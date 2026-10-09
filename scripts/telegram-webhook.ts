// telegram-webhook.ts — points River's Telegram bot at the app (https://rivrwa.com/telegram/webhook), which forwards
// each update to the agent. Telegram sends the secret in x-telegram-bot-api-secret-token; the agent refuses updates
// without it. Run once after creating the bot with @BotFather and setting the same values as Worker secrets:
//
//   cd workers/agent && npx wrangler secret put TELEGRAM_BOT_TOKEN && npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
//   (and TELEGRAM_BOT = the bot's username, without @, in workers/agent/wrangler.toml [vars])
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/telegram-webhook.ts [--info]
//
// The secret may only contain A-Z, a-z, 0-9, _ and - (Telegram's rule), e.g. `openssl rand -hex 32`.

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.RIVER_APP_URL ?? "https://rivrwa.com";
if (!token) throw new Error("set TELEGRAM_BOT_TOKEN");

const call = async (method: string, body?: unknown) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
};

if (!process.argv.includes("--info")) {
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error("set TELEGRAM_WEBHOOK_SECRET (A-Z a-z 0-9 _ -)");
  const r = await call("setWebhook", { url: `${url}/telegram/webhook`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
  console.log("setWebhook:", r.ok ? "ok" : r.description);
  const me = await call("getMe");
  console.log("bot:", (me.result as { username?: string } | undefined)?.username, "→ set TELEGRAM_BOT to this in workers/agent/wrangler.toml");
}
console.log(JSON.stringify((await call("getWebhookInfo")).result, null, 2));
