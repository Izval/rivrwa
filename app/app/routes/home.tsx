// home.tsx — the public landing: what River does, shown with the live market clock and today's signal, then the
// backtest behind the claim. Everything here is readable without an account.

import { Link } from "react-router";
import type { Route } from "./+types/home";
import { clockState } from "../../../packages/core/src/clock.ts";
import { SIGNAL_DEFAULTS } from "../../../packages/core/src/signal.ts";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { RIVER_FEE } from "../../../packages/core/src/planner.ts";
import { assets as registry, backtest, signals, simulation, stocks } from "../lib/api.server.ts";
import { Simulator } from "../components/Simulator.tsx";
import { groupStocks } from "../lib/stocks.ts";
import { StockCatalog } from "../components/StockCatalog.tsx";
import { WeekStrip } from "../components/WeekStrip.tsx";
import { BandChart } from "../components/BandChart.tsx";
import { Countdown } from "../components/Countdown.tsx";
import { Panel, Pill, btn } from "../components/ui.tsx";
import { usd, when } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [
  { title: "River: your stocks earn while Wall Street is closed" },
  { name: "description", content: "River puts your tokenized stocks to work as PancakeSwap liquidity only while the NYSE is closed, and brings them back before the open. Non-custodial." },
];

export async function loader() {
  const now = Date.now();
  const [live, bt, catalog, reg] = await Promise.all([signals(), backtest(), stocks(), registry()]);
  // Pinned stocks first (NVDAB leads the simulator), then the ones the gate enabled.
  const enabled = (reg?.filter((a) => a.enabled) ?? ASSETS.filter((a) => a.enabled).map((a) => ({ ...a, source: "pinned" as const })))
    .sort((a, b) => (a.source === b.source ? a.symbol.localeCompare(b.symbol) : a.source === "pinned" ? -1 : 1));
  const assets = enabled.map((a) => ({ symbol: a.symbol, underlying: a.underlying, auto: a.source === "auto", signal: live.find((s) => s.symbol === a.symbol)?.signal ?? null }));
  const logoOf = (token: string) => catalog?.stocks.find((s) => s.token === token)?.logo ?? null;
  const simStocks = enabled.map((a) => ({ symbol: a.symbol, underlying: a.underlying, logo: logoOf(a.token) }));
  const initialSim = simStocks[0] ? await simulation(simStocks[0].symbol, 10_000, 1) : null;
  const listed = catalog?.stocks ?? ASSETS.map((a) => ({ symbol: a.symbol, underlying: a.underlying, issuer: "bStocks" as const, token: a.token, price: null, river: a.enabled ? ("running" as const) : ("watching" as const) }));
  return { now, clock: clockState(now), assets, simStocks, initialSim, stocks: groupStocks(listed), tokens: listed.length, backtest: bt, fee: RIVER_FEE };
}

export default function Home({ loaderData: d }: Route.ComponentProps) {
  const w = d.clock.window;
  const exit = w.end - SIGNAL_DEFAULTS.exitBufferMs;
  const closed = d.clock.phase === "closed_window";
  const aprs = d.backtest?.rows.flatMap((r) => [r.netAprBase, r.netAprOthersX4]) ?? [];
  return (
    <>
      <section className="grid gap-10 lg:grid-cols-[1.25fr_1fr] lg:items-end">
        <div>
          <h1 className="condensed max-w-[14ch] text-[44px] font-semibold leading-[1.02] tracking-[-0.03em] sm:text-[68px]">
            Your stocks earn while Wall Street sleeps.
          </h1>
          <p className="mt-5 max-w-[56ch] text-lg text-ink-2">
            Tokenized shares sit idle every weekend and holiday the NYSE is closed. River lends your NVDAB and TSLAB to
            PancakeSwap as liquidity for exactly that window, collects the trading fees, and brings everything back to
            your wallet before the market reopens.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/connect/binance" className={btn.primary}>Connect Binance Wallet</Link>
            <a href="#backtest" className={btn.quiet}>See the backtest</a>
          </div>
        </div>
        <Panel className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <Pill tone={closed ? "river" : "muted"} live={closed}>{closed ? "NYSE closed" : "NYSE open"}</Pill>
            <span className="text-[13px] text-ink-3">Times in UTC</span>
          </div>
          <p className="mt-4 text-[15px] text-ink-2">
            {closed ? (d.now < exit ? "River leaves the pool in" : "The market reopens in") : "The next closed window starts in"}
          </p>
          <Countdown to={closed ? (d.now < exit ? exit : w.end) : w.start} serverNow={d.now} className="condensed block text-[52px] font-semibold leading-none tracking-[-0.02em]" />
          <p className="mt-3 text-[15px] text-ink-2">
            {w.reason === "holiday" ? "Holiday" : w.reason === "weekend+holiday" ? "Long weekend" : "Weekend"} window: {when(w.start)} to {when(w.end)}.
          </p>
        </Panel>
      </section>

      <Panel className="mt-10 px-4 pb-3 pt-4 sm:px-6">
        <WeekStrip window={w} serverNow={d.now} />
      </Panel>

      <section className="mt-20" aria-labelledby="signal">
        <h2 id="signal" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Where River would place liquidity now</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          The band is IVL's μ ± 2σ, measured on how each stock moved inside its last four closed windows. River only
          deposits the tokens you already hold, shaping the band to their ratio, so nothing is swapped on the way in or out.
        </p>
        <div className="mt-8 divide-y divide-line border-y border-line">
          {d.assets.map((a) => (
            <article key={a.symbol} className="grid gap-4 py-7 md:grid-cols-[220px_1fr] md:gap-10">
              <div>
                <h3 className="flex items-center gap-2 text-xl font-semibold">
                  {a.symbol}
                  {a.auto && <Pill tone="up">Enabled by the gate</Pill>}
                </h3>
                <p className="text-[15px] text-ink-3">{a.underlying} on BNB Chain, paired with USDT</p>
                {a.signal && (
                  <p className="tnum mt-3 text-[15px] text-ink-2">
                    Band {usd(a.signal.band.low)} to {usd(a.signal.band.high)}
                    <br />
                    {a.signal.band.basis === "ivl_2sigma" ? `IVL over ${a.signal.ivl.windows} windows` : a.signal.band.basis === "excursion" ? "Excursion rule (short history)" : "Fallback ±3%"}
                  </p>
                )}
              </div>
              {a.signal ? (
                <BandChart price={a.signal.price} band={a.signal.band} />
              ) : (
                <p className="self-center text-[15px] text-ink-2">The live signal is unavailable right now. It refreshes every 15 minutes.</p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="mt-20" aria-labelledby="simulate">
        <h2 id="simulate" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Simulate what River adds</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          Pick a stock River runs and an amount. The replay runs the same code the agent does over every past weekend and
          holiday, so the result is what River would have added after every cost.
        </p>
        <div className="mt-8">
          <Simulator stocks={d.simStocks} initial={d.initialSim} />
        </div>
      </section>

      <section className="mt-20" aria-labelledby="stocks">
        <h2 id="stocks" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Every tokenized stock on BNB Chain</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          {d.tokens} tokens from bStocks and Ondo, covering {d.stocks.length} companies and funds, synced from Binance every
          15 minutes. Every day River looks for each one's PancakeSwap pool against USDT and replays its past weekends;
          a stock that consistently adds to its holders after every cost is switched on by itself.
        </p>
        <div className="mt-8">
          <StockCatalog rows={d.stocks} />
        </div>
      </section>

      <section className="mt-20" aria-labelledby="how">
        <h2 id="how" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">One mandate, then every window runs itself</h2>
        <ol className="mt-8 grid gap-8 md:grid-cols-3">
          {[
            ["The NYSE closes", "An hour after the post-market ends, once prints settle, River opens a PancakeSwap v3 position with your shares and USDT inside the band."],
            ["Traders keep swapping", "Weekend and holiday trading pays the pool's 0.25% fee. Your position earns its share of it while the stock would otherwise sit still."],
            ["Before the reopen", "Two hours before the overnight session starts, River withdraws the position and the fees to your wallet. It leaves early if price drifts past your limit."],
          ].map(([t, body], i) => (
            <li key={t} className="border-t-2 border-river pt-4">
              <span className="tnum text-[15px] font-semibold text-river">{i + 1}</span>
              <h3 className="mt-1 text-lg font-semibold">{t}</h3>
              <p className="mt-1 text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="backtest" className="mt-20 scroll-mt-24" aria-labelledby="bt">
        <h2 id="bt" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">What the past windows paid</h2>
        {d.backtest ? (
          <>
            <p className="mt-2 max-w-[64ch] text-ink-2">
              The production signal and planner, replayed over every closed window since each pool launched, on a
              ${d.backtest.sizeUsd.toLocaleString("en-US")} position. Net of {d.backtest.costs}.
            </p>
            <Panel className="mt-8 overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 border-b border-line px-5 py-3 text-[13px] text-ink-3 sm:grid-cols-[1fr_repeat(4,auto)] sm:px-6">
                <span>Asset</span>
                <span className="text-right">Net APR, base case</span>
                <span className="text-right">Other LPs ×4</span>
                <span className="hidden text-right sm:block">Windows</span>
                <span className="hidden text-right sm:block">Windows with a gain</span>
              </div>
              {d.backtest.rows.map((r) => (
                <div key={r.asset} className="tnum grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 border-b border-line px-5 py-4 last:border-0 sm:grid-cols-[1fr_repeat(4,auto)] sm:px-6">
                  <span className="font-semibold">{r.asset}</span>
                  <span className="condensed text-right text-3xl font-semibold text-river-deep">{r.netAprBase.toFixed(1)}%</span>
                  <span className="text-right text-lg">{r.netAprOthersX4.toFixed(1)}%</span>
                  <span className="hidden text-right sm:block">{r.windows}</span>
                  <span className="hidden text-right sm:block">{r.winRateBase}%</span>
                </div>
              ))}
            </Panel>
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <p className="text-ink-2">
                <strong className="font-semibold text-ink">What we claim: about 8–25% a year</strong> on shares that
                otherwise earn nothing. The base case assumes today's liquidity from other LPs; if four times as much
                competes for the same fees, the result drops to {Math.min(...aprs).toFixed(1)}%.
              </p>
              <p className="text-ink-2">
                {d.backtest.control} Caveats: {d.backtest.caveats.join("; ")}.
              </p>
            </div>
          </>
        ) : (
          <p className="mt-2 text-ink-2">The backtest is unavailable right now. The replay lives in the repository under research/gate0.</p>
        )}
      </section>

      <section className="mt-20 grid gap-8 md:grid-cols-3" aria-label="How River keeps you in control">
        <div>
          <h3 className="text-lg font-semibold">Your wallet, your position</h3>
          <p className="mt-1 text-ink-2">No vault and no River contract. The position NFT is minted to your own wallet, and nothing is sent anywhere else.</p>
        </div>
        <div>
          <h3 className="text-lg font-semibold">Rules you set once</h3>
          <p className="mt-1 text-ink-2">How much may flow, the widest band, when to leave early, which weeks to skip. The agent only carries out that mandate.</p>
        </div>
        <div>
          <h3 className="text-lg font-semibold">What River charges</h3>
          <p className="mt-1 text-ink-2">River takes {Math.round(d.fee.share * 100)}% of the LP fees plus {usd(d.fee.fixedUsd)} per cycle. Gas is paid from your wallet in BNB.</p>
        </div>
      </section>
    </>
  );
}
