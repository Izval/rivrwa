// home.tsx — the public landing. It tells the film's story (video/film.html) in the film's own words: the opening
// stage of currents, the clock with River's next entry and exit, the edge in weekend trading, the claim and the
// replay behind it, how the position is placed, why it is safe, and River as an agent. Readable without an account.

import { Link } from "react-router";
import type { Route } from "./+types/home";
import { clockState } from "../../../packages/core/src/clock.ts";
import { SIGNAL_DEFAULTS } from "../../../packages/core/src/signal.ts";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { RIVER_FEE } from "../../../packages/core/src/planner.ts";
import { assets as registry, backtest, simulation, stocks } from "../lib/api.server.ts";
import { Simulator } from "../components/Simulator.tsx";
import { groupStocks } from "../lib/stocks.ts";
import { StockCatalog } from "../components/StockCatalog.tsx";
import { WeekStrip } from "../components/WeekStrip.tsx";
import { RiverWaves } from "../components/RiverWaves.tsx";
import { useScrollReveal } from "../components/useScrollReveal.ts";
import { Countdown } from "../components/Countdown.tsx";
import type { ReactNode } from "react";
import { Panel, Pill, btn } from "../components/ui.tsx";
import { usd, when } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [
  { title: "River: your stocks earn while Wall Street is closed" },
  { name: "description", content: "River puts your tokenized stocks to work as PancakeSwap liquidity only while the NYSE is closed, and brings them back before the open. Non-custodial." },
];

export async function loader() {
  const now = Date.now();
  const [bt, catalog, reg] = await Promise.all([backtest(), stocks(), registry()]);
  // Pinned stocks first (NVDAB leads the simulator), then the ones the gate enabled.
  const enabled = (reg?.filter((a) => a.enabled) ?? ASSETS.filter((a) => a.enabled).map((a) => ({ ...a, source: "pinned" as const })))
    .sort((a, b) => (a.source === b.source ? a.symbol.localeCompare(b.symbol) : a.source === "pinned" ? -1 : 1));
  const logoOf = (token: string) => catalog?.stocks.find((s) => s.token === token)?.logo ?? null;
  const simStocks = enabled.map((a) => ({ symbol: a.symbol, underlying: a.underlying, logo: logoOf(a.token) }));
  const initialSim = simStocks[0] ? await simulation(simStocks[0].symbol, 10_000, 1) : null;
  const listed = catalog?.stocks ?? ASSETS.map((a) => ({ symbol: a.symbol, underlying: a.underlying, issuer: "bStocks" as const, token: a.token, price: null, river: a.enabled ? ("running" as const) : ("watching" as const) }));
  return { now, clock: clockState(now), simStocks, initialSim, stocks: groupStocks(listed), tokens: listed.length, backtest: bt, fee: RIVER_FEE };
}

/** One beat of the story: a small mono kicker, the line from the film, and the paragraph under it. */
function Beat({ kick, title, children, className = "" }: { kick: string; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={className} data-reveal>
      <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-river">{kick}</p>
      <h2 className="mt-2 text-[30px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[38px]">{title}</h2>
      {children && <div className="mt-3 max-w-[60ch] space-y-3 text-[17px] text-ink-2">{children}</div>}
    </div>
  );
}

/** A figure the story leans on, big and condensed, with where it comes from. It counts up when it scrolls in. */
function Figure({ value, prefix = "", suffix = "", label, source }: { value: number; prefix?: string; suffix?: string; label: string; source: string }) {
  return (
    <div className="rounded-panel border border-line bg-solid p-5 shadow-[0_1px_2px_rgb(14_23_38/0.05)] sm:p-6" data-reveal>
      <div className="tnum condensed text-[48px] font-semibold leading-none tracking-[-0.02em] text-river-deep" data-count={value} data-prefix={prefix} data-suffix={suffix}>
        {prefix}{value.toFixed(1)}{suffix}
      </div>
      <p className="mt-2 font-semibold text-ink">{label}</p>
      <p className="mt-1 text-[13px] text-ink-3">{source}</p>
    </div>
  );
}

export default function Home({ loaderData: d }: Route.ComponentProps) {
  useScrollReveal();
  const w = d.clock.window;
  const exit = w.end - SIGNAL_DEFAULTS.exitBufferMs;
  const entry = w.start + SIGNAL_DEFAULTS.settleMs;
  const closed = d.clock.phase === "closed_window";
  const [label, to] = closed
    ? d.now < entry ? ["River enters the pool in", entry] : d.now < exit ? ["River leaves the pool in", exit] : ["The market reopens in", w.end]
    : ["River enters the pool in", entry];
  const aprs = d.backtest?.rows.flatMap((r) => [r.netAprBase, r.netAprOthersX4]) ?? [];
  const kind = w.reason === "holiday" ? "Holiday" : w.reason === "weekend+holiday" ? "Long weekend" : "Weekend";
  return (
    <>
      <section className="grid items-center gap-8 lg:grid-cols-[1fr_1fr] lg:gap-6">
        <div>
          <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-river">Real-world assets, made fluid</p>
          <h1 className="mt-4 text-[52px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[76px]">
            Let them trade.
            <span className="block text-river">You earn.</span>
          </h1>
          <p className="mt-6 max-w-[48ch] text-[19px] text-ink-2">
            Earn from weekend trading, without trading. River puts your tokenized stocks where the weekend trades
            happen, <strong className="font-semibold text-ink">only while Wall Street is closed</strong>, and brings them
            back to your wallet before it opens.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/connect/binance" className={btn.primary}>Connect Binance Wallet</Link>
            <a href="#returns" className={btn.quiet}>See what it pays</a>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[400px] lg:max-w-none">
          <RiverWaves />
        </div>
      </section>

      <Panel className="mt-6 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div>
            <Pill tone={closed ? "river" : "muted"} live={closed}>{closed ? "NYSE closed" : "NYSE open"}</Pill>
            <p className="mt-2 text-[15px] text-ink-2">{kind} window: {when(w.start)} to {when(w.end)}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-[15px] text-ink-2">{label}</p>
            <Countdown to={to} serverNow={d.now} className="condensed block text-[44px] font-semibold leading-none tracking-[-0.02em] sm:text-[52px]" />
          </div>
        </div>
        <WeekStrip window={w} serverNow={d.now} />
      </Panel>

      <section className="mt-24 grid gap-12 lg:grid-cols-2" aria-label="Why weekends">
        <div>
          <Beat kick="The edge" title="Their weekend trading pays you.">
            <p>
              Someone is always trading tokenized stocks on weekends. Every trade pays a fee. River puts your shares where
              those trades happen, so you keep holding, do nothing, and earn.
            </p>
          </Beat>
          <div className="mt-6"><Figure value={3.7} prefix="$" suffix="M" label="traded on an average weekend, in a single pool" source="One bStock pool on PancakeSwap v3, Jul–Sep 2026" /></div>
        </div>
        <div>
          <Beat kick="The clock" title="The market closes. The chain doesn't.">
            <p>
              From Friday night to Sunday night the NYSE is closed, but bStocks keep trading on-chain. With no news, the
              price drifts sideways, and every trade still pays a fee.
            </p>
          </Beat>
          <div className="mt-6"><Figure value={2.9} suffix="%" label="48 h price range on weekends, against 5.8% on weekdays" source="NVDAB/USDT, Jul–Sep 2026" /></div>
        </div>
      </section>

      <section id="returns" className="mt-24 scroll-mt-24" aria-labelledby="bt">
        <Beat kick="The opportunity" title={<span id="bt">~8–25% a year, on top of your stock.</span>}>
          <p>
            Earned from weekend trading fees, net of impermanent loss, gas and River's fee. Your shares are back before the
            open, so you keep the stock's moves.
          </p>
        </Beat>
        {d.backtest ? (
          <>
            <Panel className="mt-8 overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 border-b border-line px-5 py-3 text-[13px] text-ink-2 sm:grid-cols-[1fr_repeat(4,auto)] sm:px-6">
                <span>Asset</span>
                <span className="text-right">Net APR, base case</span>
                <span className="text-right">Other LPs ×4</span>
                <span className="hidden text-right sm:block">Windows</span>
                <span className="hidden text-right sm:block">Windows with a gain</span>
              </div>
              {d.backtest.rows.map((r) => (
                <div key={r.asset} className="tnum grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 border-b border-line px-5 py-4 last:border-0 sm:grid-cols-[1fr_repeat(4,auto)] sm:px-6">
                  <span className="font-semibold">{r.asset}</span>
                  <span className="condensed text-right text-3xl font-semibold text-river-deep" data-count={r.netAprBase.toFixed(1)} data-suffix="%">{r.netAprBase.toFixed(1)}%</span>
                  <span className="text-right text-lg">{r.netAprOthersX4.toFixed(1)}%</span>
                  <span className="hidden text-right sm:block">{r.windows}</span>
                  <span className="hidden text-right sm:block">{r.winRateBase}%</span>
                </div>
              ))}
            </Panel>
            <div className="mt-6 grid gap-6 md:grid-cols-2" data-reveal="stagger">
              <p className="text-ink-2">
                The production signal and planner, replayed over every closed window since each pool launched, on a
                ${d.backtest.sizeUsd.toLocaleString("en-US")} position. Net of {d.backtest.costs}. If four times as much
                liquidity competes for the same fees, the result drops to {Math.min(...aprs).toFixed(1)}%, which is why
                we claim about 8–25%.
              </p>
              <p className="text-ink-2">
                {d.backtest.control} Caveats: {d.backtest.caveats.join("; ")}.
              </p>
            </div>
          </>
        ) : (
          <p className="mt-4 text-ink-2">The backtest is unavailable right now. The replay lives in the repository under research/gate0.</p>
        )}
      </section>

      <section className="mt-20" aria-labelledby="simulate">
        <h2 id="simulate" className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Try it with your own amount</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          Pick a stock River runs and an amount. The replay runs the same code the agent does over every past weekend and
          holiday, so the result is what River would have added after every cost.
        </p>
        <div className="mt-8" data-reveal>
          <Simulator stocks={d.simStocks} initial={d.initialSim} />
        </div>
      </section>

      <section className="mt-24" aria-label="How River places the position">
        <ol className="grid gap-5 lg:grid-cols-3" data-reveal="stagger">
          {([
            ["How: the position", "A tight band where the trades happen.", "River adds your shares and USDT as concentrated liquidity on PancakeSwap v3. Every swap through the band pays you a fee, and on weekends the price rarely leaves it."],
            ["How: the band", "Measured, not guessed.", "River reads how price moved inside the last four weekends, each rebased to its own start, and sizes the band to μ ± 2σ. Your shares go in as they are: nothing is swapped."],
            ["How: the timing", "In after the close. Out before the open.", "1 hour after the close, River deposits your shares and USDT into the band. 2 hours before the reopen, it withdraws. Your position comes back, plus the fees."],
          ] as const).map(([kick, title, body], i) => (
            <li key={kick} className="rounded-panel border border-line bg-solid p-6 shadow-[0_1px_2px_rgb(14_23_38/0.05)]">
              <div className="flex items-center gap-3">
                <span className="tnum flex size-8 items-center justify-center rounded-full bg-river text-[15px] font-semibold text-white">{i + 1}</span>
                <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-river">{kick}</span>
              </div>
              <h3 className="mt-4 text-[21px] font-semibold leading-snug tracking-[-0.01em]">{title}</h3>
              <p className="mt-2 text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-24 grid gap-12 lg:grid-cols-2" aria-label="Safe, and on your terms">
        <Beat kick="Safe by design" title="We never touch your funds.">
          <p>
            Everything runs from your own wallet, so you don't have to trust us. River's agent can only move your shares
            into the pool and back. Binance checks every move first, and anything else is refused.
          </p>
          <p>No vault and no River contract: the position is minted to your wallet.</p>
        </Beat>
        <Beat kick="On your terms" title="Weekly, or on autopilot for months.">
          <p>
            With a Binance Wallet, renew each week with a tap in the Binance app. With any other wallet, set it once for 1,
            3 or 6 months. Stop it whenever you want.
          </p>
          <p>
            River takes {Math.round(d.fee.share * 100)}% of the fees plus {usd(d.fee.fixedUsd)} a weekend. Gas is paid from
            your wallet in BNB.
          </p>
        </Beat>
      </section>

      <section className="mt-24" aria-labelledby="stocks">
        <h2 id="stocks" className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Every tokenized stock on BNB Chain</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          {d.tokens} tokens from bStocks and Ondo, covering {d.stocks.length} companies and funds, synced from Binance every
          15 minutes. Every day River looks for each one's PancakeSwap pool against USDT and replays its past weekends;
          a stock that consistently adds to its holders after every cost is switched on by itself.
        </p>
        <div className="mt-8" data-reveal>
          <StockCatalog rows={d.stocks} />
        </div>
      </section>

      <section className="mt-24 flex flex-wrap items-end justify-between gap-6 rounded-panel bg-ink p-6 text-white sm:p-10" aria-label="River for agents" data-reveal>
        <div>
          <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[#8fb0ff]">River is an agent too</p>
          <h2 className="mt-2 text-[30px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[38px]">Other agents hire it.</h2>
          <p className="mt-3 max-w-[56ch] text-[17px] text-white/75">
            River is ERC-8004 agent #365864 on BNB Chain. Any agent can buy its weekend plan for $0.10 over x402 or MCP.
          </p>
        </div>
        <Link to="/agent" className="inline-flex min-h-11 items-center rounded-control bg-white px-5 text-[15px] font-semibold text-ink transition-colors hover:bg-river-mist">
          River for agents
        </Link>
      </section>

      <section className="mt-24 text-center" aria-label="Start" data-reveal="stagger">
        <h2 className="text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[64px]">
          Hold your stocks.
          <span className="block text-river">Let the weekend pay.</span>
        </h2>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/connect/binance" className={btn.primary}>Connect Binance Wallet</Link>
          <Link to="/connect/altana" className={btn.quiet}>Use any other wallet</Link>
        </div>
      </section>
    </>
  );
}
