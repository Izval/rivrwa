// telegram.ts — River's only outbound channel: cycle reports, alerts, and the weekly Agentic Wallet renewal
// link. A user links a chat by opening t.me/<bot>?start=<token> from River; the app forwards the webhook here.

import type { CycleRecord } from "../../../agent/src/store.ts";
import { randomId } from "./crypto.ts";
import { getUser, setTelegram } from "./db.ts";

export interface TelegramEnv {
  DB: D1Database;
  TELEGRAM_BOT: string;
  TELEGRAM_BOT_TOKEN?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(env: TelegramEnv, chatId: string, html: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.log(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function notifyOwner(env: TelegramEnv, owner: string, html: string): Promise<void> {
  const u = await getUser(env.DB, owner);
  if (u?.telegramChatId) await sendTelegram(env, u.telegramChatId, html);
}

export async function linkToken(env: TelegramEnv, owner: string): Promise<string> {
  const token = randomId(12);
  await env.DB.prepare("INSERT INTO telegram_links (token, owner, created_at) VALUES (?, ?, ?)").bind(token, owner, Date.now()).run();
  return `https://t.me/${env.TELEGRAM_BOT}?start=${token}`;
}

interface Update { message?: { chat: { id: number }; text?: string } }

/** `/start <token>` binds the chat to the River account that created the token (valid for 1 hour). */
export async function handleUpdate(env: TelegramEnv, u: Update): Promise<void> {
  const m = u.message;
  const token = m?.text?.match(/^\/start\s+([0-9a-f]{24})$/)?.[1];
  if (!m || !token) return;
  const row = await env.DB.prepare("SELECT owner, created_at FROM telegram_links WHERE token = ?").bind(token).first<{ owner: string; created_at: number }>();
  await env.DB.prepare("DELETE FROM telegram_links WHERE token = ?").bind(token).run();
  const chat = String(m.chat.id);
  if (!row || Date.now() - row.created_at > 3_600_000) {
    await sendTelegram(env, chat, "That link has expired. Open River and link Telegram again.");
    return;
  }
  await setTelegram(env.DB, row.owner, chat);
  await sendTelegram(env, chat, `River is linked to <code>${esc(row.owner)}</code>. You will get a message when a cycle starts or ends, and before your Binance session needs renewing.`);
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const bscscan = (tx: string) => `<a href="https://bscscan.com/tx/${tx}">${tx.slice(0, 10)}…</a>`;

export function cycleMessage(c: CycleRecord): string {
  const shares = c.sharesAfter - c.sharesBefore;
  return [
    `<b>River cycle closed · ${esc(c.asset)}</b> (${esc(c.exitReason.replace("_", " "))})`,
    `Fees earned: <b>${usd(c.feesUsd)}</b> · IL vs holding: ${usd(c.ilUsd)} · River fee: ${usd(c.riverFeeUsd)}`,
    `Shares: ${c.sharesBefore.toFixed(4)} → ${c.sharesAfter.toFixed(4)} (${shares >= 0 ? "+" : ""}${shares.toFixed(4)})`,
    `Txs: add ${bscscan(c.txs.add)}${c.txs.claim ? ` · claim ${bscscan(c.txs.claim)}` : ""} · remove ${bscscan(c.txs.remove)}`,
  ].join("\n");
}

export const escapeHtml = esc;
