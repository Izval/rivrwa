// Simulator.tsx — "what would River have added?" for a stock River runs, an amount and a level of competition from
// other liquidity providers. It replays the stock's past closed windows through the same code that enables stocks
// (rivrwa-api /v1/simulate), so the answer is net of impermanent loss, gas, River's fee and restoring the share
// count. It shows only what River adds: the stock's own return is on top and is not modelled.

import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { COMPETITION, WINDOWS_PER_YEAR, clampSize, type Competition, type Simulation } from "../lib/simulation.ts";
import { usd } from "../lib/format.ts";
import { Logo } from "./StockCatalog.tsx";
import { WeeklyBars } from "./WeeklyBars.tsx";
import { Panel, Stat, btn } from "./ui.tsx";

export interface SimStock { symbol: string; underlying: string; logo: string | null }

const PRESETS = [1_000, 10_000, 50_000];

export function Simulator({ stocks, initial }: { stocks: SimStock[]; initial: Simulation | null }) {
  const [symbol, setSymbol] = useState(initial?.symbol ?? stocks[0]?.symbol ?? "");
  const [amount, setAmount] = useState(initial?.sizeUsd ?? 10_000);
  const [x, setX] = useState<Competition>(1);
  const f = useFetcher<{ sim: Simulation | null; error: string | null }>();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; } // the server already rendered the default
    const id = setTimeout(() => f.load(`/simulate?symbol=${symbol}&size=${clampSize(amount)}&x=${x}`), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- f.load is stable; only the inputs matter
  }, [symbol, amount, x]);

  if (stocks.length === 0) return null;
  const sim = f.data ? f.data.sim : initial;
  const stats = sim?.scenarios[`x${x}` as const];
  const size = clampSize(amount);
  const perYear = stats ? (size * stats.apr) / 100 : 0;
  const busy = f.state !== "idle";
  return (
    <Panel className="p-5 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-10">
        <div className="space-y-6">
          <fieldset>
            <legend className="text-[15px] font-semibold">Stock</legend>
            <div className="mt-2 flex flex-wrap gap-2" role="radiogroup">
              {stocks.map((s) => (
                <button
                  key={s.symbol} type="button" role="radio" aria-checked={symbol === s.symbol} onClick={() => setSymbol(s.symbol)}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3 text-[15px] font-semibold transition-colors ${symbol === s.symbol ? "border-river bg-river-mist text-river-deep" : "border-line bg-solid hover:border-river"}`}
                >
                  <Logo src={s.logo} name={s.underlying} size={20} />
                  {s.symbol}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="sim-amount" className="text-[15px] font-semibold">Amount</label>
            <div className="mt-2 flex items-center rounded-control border border-line bg-solid focus-within:border-river">
              <span className="pl-3 text-ink-3">$</span>
              <input
                id="sim-amount" type="number" inputMode="numeric" min={100} max={1_000_000} step={100} value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="tnum w-full bg-transparent px-2 py-2.5 text-[17px] font-semibold focus:outline-none"
              />
            </div>
            <div className="mt-2 flex gap-2">
              {PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => setAmount(p)} className={`rounded-full px-3 py-1 text-[14px] font-semibold ${amount === p ? "bg-river-mist text-river-deep" : "text-ink-2 hover:text-ink"}`}>
                  {usd(p, 0)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-ink-3">Half in the stock, half in USDT, as River deposits it.</p>
          </div>

          <fieldset>
            <legend className="text-[15px] font-semibold">Other liquidity providers</legend>
            <div className="mt-2 inline-flex flex-wrap rounded-control border border-line bg-solid p-1" role="radiogroup">
              {COMPETITION.map((c) => (
                <button
                  key={c.x} type="button" role="radio" aria-checked={x === c.x} onClick={() => setX(c.x)}
                  className={`min-h-9 rounded-[9px] px-3 text-[14px] font-semibold transition-colors ${x === c.x ? "bg-river text-white" : "text-ink-2 hover:text-ink"}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-ink-3">More liquidity in the same range splits the same fees more ways.</p>
          </fieldset>
        </div>

        <div className={`transition-opacity ${busy ? "opacity-60" : ""}`} aria-live="polite" aria-busy={busy}>
          {!sim || !stats ? (
            <p className="text-ink-2">{f.data?.error ?? "The replay for this stock is not ready yet. It appears after its next review."}</p>
          ) : (
            <>
              <p className="text-[15px] text-ink-2">River would have added, on top of holding {sim.symbol}</p>
              <p className="condensed tnum text-[56px] font-semibold leading-none tracking-[-0.02em] text-river-deep">
                {stats.apr >= 0 ? "+" : "−"}{Math.abs(stats.apr).toFixed(1)}%<span className="ml-2 text-2xl text-ink-2">a year</span>
              </p>
              <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Stat label="Per year" value={usd(perYear, 0)} hint={`on ${usd(size, 0)}`} />
                <Stat label="Per weekend" value={usd(perYear / WINDOWS_PER_YEAR, 2)} />
                <Stat label="Weekends that gained" value={`${Math.round((stats.winRate / 100) * stats.windows)} of ${stats.windows}`} />
              </div>
              <div className="mt-6">
                <WeeklyBars windows={sim.windows} />
              </div>
              <p className="mt-4 text-[13px] leading-relaxed text-ink-3">
                A replay of this stock's past closed windows{sim.sizeUsd !== size ? `, simulated at ${usd(sim.sizeUsd, 0)}` : ""}. It
                counts impermanent loss, gas, River's fee and buying back to the same share count; it does not promise the
                next weekend. The stock's own return comes on top.
              </p>
              <Link to={`/mandate?asset=${sim.symbol}`} className={`${btn.primary} mt-5`}>Set up {sim.symbol}</Link>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
