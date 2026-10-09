// StockCatalog.tsx — every tokenized stock Binance lists on BNB Chain, one row per underlying, searchable, 30 to a
// page. The rows River runs come first, then the ones in review, then those whose pool was replayed and does not
// qualify yet. Discovery enables stocks by itself, so the list changes without a deploy. The exact rule a stock
// missed stays in the API (/v1/gate/:symbol); the list only says it is not there yet.

import { useMemo, useState } from "react";
import { hasPool, matches, type StockRow } from "../lib/stocks.ts";
import { usd } from "../lib/format.ts";
import { Pill, btn } from "./ui.tsx";

const PAGE = 30;
type Issuer = "all" | "bStocks" | "Ondo";
type Show = "all" | "pools";

export function StockCatalog({ rows }: { rows: StockRow[] }) {
  const [q, setQ] = useState("");
  const [issuer, setIssuer] = useState<Issuer>("all");
  const [show, setShow] = useState<Show>("all");
  const [page, setPage] = useState(0);
  const shown = useMemo(
    () => rows.filter((r) => matches(r, q) && (issuer === "all" || r.tokens.some((t) => t.issuer === issuer)) && (show === "all" || hasPool(r))),
    [rows, q, issuer, show],
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const at = Math.min(page, pages - 1);
  const visible = shown.slice(at * PAGE, (at + 1) * PAGE);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <span className="sr-only">Search stocks</span>
          <input
            type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search a ticker, e.g. AAPL"
            className="w-full rounded-control border border-line bg-solid px-4 py-2.5 text-[15px] focus:border-river focus:outline-none"
          />
        </label>
        <div className="flex gap-1" role="group" aria-label="Issuer">
          {(["all", "bStocks", "Ondo"] as const).map((i) => (
            <button
              key={i} type="button" aria-pressed={issuer === i} onClick={() => { setIssuer(i); setPage(0); }}
              className={`min-h-11 rounded-control px-3.5 text-[15px] font-semibold transition-colors ${issuer === i ? "bg-river-mist text-river-deep" : "text-ink-2 hover:text-ink"}`}
            >
              {i === "all" ? "All issuers" : i}
            </button>
          ))}
        </div>
        <label className="flex min-h-11 items-center gap-2 text-[15px] text-ink-2">
          <input type="checkbox" checked={show === "pools"} onChange={(e) => { setShow(e.target.checked ? "pools" : "all"); setPage(0); }} className="size-4 accent-[var(--river)]" />
          Only stocks with a pool
        </label>
        <span className="tnum ml-auto text-[14px] text-ink-3">{shown.length} of {rows.length}</span>
      </div>

      <ul className="mt-5 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((r) => (
          <li key={r.underlying} className="border-b border-line py-3">
            <div className="flex items-center gap-3">
              <Logo src={r.logo} name={r.underlying} />
              <span className="w-14 shrink-0 font-semibold">{r.underlying}</span>
              <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                {r.state === "running" ? (
                  <Pill tone="river" live>River runs it</Pill>
                ) : r.state === "reviewing" ? (
                  <Pill>In review</Pill>
                ) : hasPool(r) ? (
                  <Pill tone="muted">Criteria not met yet</Pill>
                ) : (
                  r.tokens.map((t) => (
                    <span key={t.symbol} className="rounded-md bg-[rgb(14_23_38/0.05)] px-1.5 py-0.5 text-[12px] font-medium text-ink-2" title={`${t.issuer} token`}>
                      {t.symbol}
                    </span>
                  ))
                )}
              </span>
              <span className="tnum shrink-0 text-[14px] text-ink-2">{r.price ? usd(r.price) : ""}</span>
            </div>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="mt-6 text-ink-2">No tokenized stock matches “{q}” yet. The list updates from Binance every 15 minutes.</p>}
      {pages > 1 && (
        <nav className="mt-6 flex items-center gap-3" aria-label="Stock list pages">
          <button type="button" onClick={() => setPage(at - 1)} disabled={at === 0} className={btn.quiet}>Previous</button>
          <span className="tnum text-[15px] text-ink-2">Page {at + 1} of {pages}</span>
          <button type="button" onClick={() => setPage(at + 1)} disabled={at === pages - 1} className={btn.quiet}>Next</button>
        </nav>
      )}
    </div>
  );
}

/** The token's logo from Binance, or its initial when there is none or it fails to load. */
export function Logo({ src, name, size = 24 }: { src: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (!src || failed) {
    return (
      <span aria-hidden style={box} className="grid shrink-0 place-items-center rounded-full bg-river-mist text-[11px] font-semibold text-river-deep">
        {name.slice(0, 1)}
      </span>
    );
  }
  return <img src={src} alt="" style={box} loading="lazy" decoding="async" onError={() => setFailed(true)} className="shrink-0 rounded-full bg-solid object-cover" />;
}
