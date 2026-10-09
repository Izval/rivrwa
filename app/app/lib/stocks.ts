// stocks.ts — the stock catalog as the landing shows it: one row per underlying company or fund, with every token
// that tracks it on BNB Chain (bStocks, Ondo). The catalog itself syncs from Binance RWA Data in rivrwa-api.

export interface StockListing {
  symbol: string;
  underlying: string;
  issuer: "bStocks" | "Ondo";
  token: string;
  logo?: string | null;
  price: number | null;
  river: "running" | "watching";
  state?: "running" | "reviewing" | "not_eligible" | "unreviewed";
  reason?: string | null;
}

export type RowState = "running" | "reviewing" | "not_eligible" | "unreviewed";

export interface StockRow {
  underlying: string;
  tokens: { symbol: string; issuer: StockListing["issuer"]; running: boolean }[];
  price: number | null;
  logo: string | null;
  running: boolean;
  /** The most advanced state among its tokens, and why the best candidate does not run (if it does not). */
  state: RowState;
  reason: string | null;
}

const RANK: Record<RowState, number> = { running: 3, reviewing: 2, not_eligible: 1, unreviewed: 0 };
/** Reasons that only say "no pool" carry no news; any other reason means the stock was actually replayed. */
export const hasPool = (r: StockRow) => r.state === "running" || r.state === "reviewing" || (!!r.reason && !/^no PancakeSwap/.test(r.reason));

export function groupStocks(list: StockListing[]): StockRow[] {
  const rows = new Map<string, StockRow>();
  for (const s of list) {
    const r = rows.get(s.underlying) ?? { underlying: s.underlying, tokens: [], price: null, logo: null, running: false, state: "unreviewed" as RowState, reason: null };
    const state: RowState = s.river === "running" ? "running" : s.state ?? "unreviewed";
    r.tokens.push({ symbol: s.symbol, issuer: s.issuer, running: s.river === "running" });
    r.price ??= s.price;
    r.logo ??= s.logo ?? null;
    r.running ||= s.river === "running";
    if (RANK[state] > RANK[r.state] || (RANK[state] === RANK[r.state] && !r.reason)) {
      r.state = state;
      r.reason = state === "running" ? null : s.reason ?? null;
    }
    rows.set(s.underlying, r);
  }
  return [...rows.values()].sort((a, b) => RANK[b.state] - RANK[a.state] || Number(hasPool(b)) - Number(hasPool(a)) || a.underlying.localeCompare(b.underlying));
}

export const matches = (r: StockRow, q: string) => {
  const t = q.trim().toUpperCase();
  return !t || r.underlying.includes(t) || r.tokens.some((k) => k.symbol.toUpperCase().includes(t));
};
