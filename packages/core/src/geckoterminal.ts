// geckoterminal.ts — keyless OHLCV for BSC pools (the IVL PriceSource for stock pools).
//
// GeckoTerminal omits hours with no trades. Stock pools are thin enough that this matters:
// flat, zero-volume candles look like a perfect range and would inflate IVL, so gaps are
// carried forward explicitly (flagged `filled`) and callers can drop them.

import type { IvlCandle } from "./ivl.ts";

const BASE = "https://api.geckoterminal.com/api/v2/networks/bsc/pools";
const TF: Record<string, [string, number]> = {
  "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1],
};

export interface Candle extends IvlCandle {
  filled?: boolean;
}

export async function fetchOhlcv(
  pool: string, token: string, timeframe: keyof typeof TF | string, limit = 500,
  opts: { before?: number; fetchImpl?: typeof fetch } = {},
): Promise<Candle[]> {
  const [unit, agg] = TF[timeframe] ?? TF["1h"];
  const q = new URLSearchParams({ aggregate: String(agg), limit: String(Math.min(limit, 1000)), currency: "usd", token });
  if (opts.before) q.set("before_timestamp", String(opts.before));
  const r = await (opts.fetchImpl ?? fetch)(`${BASE}/${pool}/ohlcv/${unit}?${q}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`geckoterminal ${r.status}`);
  const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const rows = (j.data?.attributes?.ohlcv_list ?? []).map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol }));
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Up to `pages` × 1000 hourly candles, newest backwards (the gate needs every closed window since launch). */
export async function fetchOhlcvHistory(
  pool: string, token: string, opts: { pages?: number; fetchImpl?: typeof fetch; pauseMs?: number; retryMs?: number; retries?: number } = {},
): Promise<Candle[]> {
  const byTs = new Map<number, Candle>();
  let before: number | undefined;
  for (let i = 0; i < (opts.pages ?? 6); i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 2500)); // free tier: ~30 req/min
    let rows: Candle[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        rows = await fetchOhlcv(pool, token, "1h", 1000, { before, fetchImpl: opts.fetchImpl });
        break;
      } catch (e) {
        // A 429 clears within a minute on the free tier; anything else is not worth waiting for.
        if (attempt >= (opts.retries ?? 2) || !/429/.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, opts.retryMs ?? 20_000));
      }
    }
    for (const c of rows) byTs.set(c.ts, c);
    if (rows.length < 1000) break;
    before = rows[0].ts;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Fill missing periods with flat, zero-volume candles (price carried forward). */
export function fillGaps(candles: Candle[], stepSec: number): Candle[] {
  if (candles.length === 0) return [];
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = out[out.length - 1];
    if (prev) for (let t = prev.ts + stepSec; t < c.ts; t += stepSec) out.push({ ts: t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, vol: 0, filled: true });
    out.push(c);
  }
  return out;
}

/** Aggregate consecutive candles (e.g. 1h → 4h). */
export function aggregate(candles: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + n <= candles.length; i += n) {
    const g = candles.slice(i, i + n);
    out.push({ ts: g[0].ts, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[n - 1].c, vol: g.reduce((s, x) => s + x.vol, 0) });
  }
  return out;
}
