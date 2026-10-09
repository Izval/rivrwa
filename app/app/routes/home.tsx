// home.tsx — the public landing, told as a weekend. It alternates two grounds: water (deep navy, the currents of
// River's film: the market is closed and River is at work) and land (porcelain, hairline instruments: the measured,
// proven side). Stages meet at a moving wave line, so the page changes state as it scrolls instead of reading flat.
//
//   water  hero: the claim, and the tide gauge (the hours around the next closed window, its water, River's entry
//          and exit, and a countdown in seconds)
//   land   01 the edge, 02 the clock: the two facts the idea rests on
//   water  03 proven: the replay of every past window
//   land   try it; 04 how it runs (the band, drawn as a schematic); 05 safe, 06 on your terms; every stock
//   water  07 River as an agent, and the closing line
//
// The copy is the film's (video/film.html). anime.js plays the hero in once (useHeroIntro), draws the schematic with
// the scroll, and rises the other beats into place (useScrollReveal). Readable without an account or JavaScript.

import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { createScope, createTimeline, splitText, stagger, utils } from "animejs";
import type { Route } from "./+types/home";
import { clockState } from "../../../packages/core/src/clock.ts";
import { SIGNAL_DEFAULTS } from "../../../packages/core/src/signal.ts";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { RIVER_FEE } from "../../../packages/core/src/planner.ts";
import { assets as registry, backtest, simulation, stocks } from "../lib/api.server.ts";
import { groupStocks } from "../lib/stocks.ts";
import { Simulator } from "../components/Simulator.tsx";
import { StockCatalog } from "../components/StockCatalog.tsx";
import { Currents } from "../components/Currents.tsx";
import { WaveEdge } from "../components/WaveEdge.tsx";
import { TideGauge } from "../components/TideGauge.tsx";
import { BandSchematic } from "../components/BandSchematic.tsx";
import { useScrollReveal } from "../components/useScrollReveal.ts";
import { btn } from "../components/ui.tsx";
import { usd } from "../lib/format.ts";

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

const WATER = "#040a1c", LAND = "var(--bg)";
const ghost = "inline-flex min-h-11 items-center justify-center rounded-control border border-white/25 px-5 text-[15px] font-semibold text-white transition-colors hover:border-white/70";

/** One beat of the story: a numbered mono kicker, the line from the film, and the paragraph under it. */
function Beat({ kick, title, children, dark = false, className = "" }: { kick: string; title: ReactNode; children?: ReactNode; dark?: boolean; className?: string }) {
  return (
    <div className={className} data-reveal>
      <p className={`font-mono text-[13px] font-semibold uppercase tracking-[0.16em] ${dark ? "text-[#8fb0ff]" : "text-river"}`}>{kick}</p>
      <h2 className="mt-3 text-[32px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[44px]">{title}</h2>
      {children && <div className={`mt-4 max-w-[60ch] space-y-3 text-[17px] ${dark ? "text-white/70" : "text-ink-2"}`}>{children}</div>}
    </div>
  );
}

/** A figure the story leans on, big and condensed, with where it comes from. It counts up when it scrolls in. */
function Figure({ value, prefix = "", suffix = "", label, source }: { value: number; prefix?: string; suffix?: string; label: string; source: string }) {
  return (
    <div className="relative overflow-hidden rounded-panel border border-line bg-solid p-5 shadow-[0_1px_2px_rgb(14_23_38/0.05)] sm:p-6" data-reveal>
      <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-[repeating-linear-gradient(90deg,var(--ink-3)_0_1px,transparent_1px_10px)] opacity-40" />
      <div className="tnum condensed text-[56px] font-semibold leading-none tracking-[-0.02em] text-river-deep" data-count={value} data-prefix={prefix} data-suffix={suffix}>
        {prefix}{value.toFixed(1)}{suffix}
      </div>
      <p className="mt-2 font-semibold text-ink">{label}</p>
      <p className="mt-1 font-mono text-[12px] text-ink-3">{source}</p>
    </div>
  );
}

/** The hero plays in once per visit: the headline rises word by word out of its own line, then the rest follows.
 *  Only when root.tsx marked <html class="intro"> before paint (motion allowed), so nothing flashes. */
function useHeroIntro() {
  useEffect(() => {
    if (!document.documentElement.classList.contains("intro")) return;
    const scope = createScope().add(() => {
      const tl = createTimeline({ defaults: { ease: "out(4)" } });
      const title = document.querySelector<HTMLElement>("[data-intro=title]");
      const split = title ? splitText(title, { words: { wrap: "clip" } }) : null;
      if (title && split) {
        utils.set(split.words, { y: "110%" });
        utils.set(title, { opacity: 1 });
        tl.add(split.words, { y: "0%", duration: 1100, delay: stagger(90) }, 120);
      }
      const fades = document.querySelectorAll("[data-intro=fade]");
      utils.set(fades, { opacity: 0, y: 18 });
      tl.add(fades, { opacity: 1, y: 0, duration: 1000, delay: stagger(140) }, 500);
      return () => split?.revert();
    });
    return () => scope.revert();
  }, []);
}

export default function Home({ loaderData: d }: Route.ComponentProps) {
  useHeroIntro();
  useScrollReveal();
  const w = d.clock.window;
  const aprs = d.backtest?.rows.flatMap((r) => [r.netAprBase, r.netAprOthersX4]) ?? [];
  return (
    <>
      {/* ── water: the hero ── */}
      <section className="water bleed relative isolate -mt-8 overflow-hidden sm:-mt-12">
        <div aria-hidden className="absolute inset-0 -z-10 [background:radial-gradient(900px_520px_at_80%_30%,rgb(31_91_255/0.34),transparent_65%),radial-gradient(760px_420px_at_0%_105%,rgb(31_91_255/0.2),transparent_60%)]" />
        <Currents data-intro="fade" className="absolute inset-x-0 top-0 -z-10 h-[64%] w-full" from={0.34} to={0.94} lines={8} />
        <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#040a1c_0%,rgb(4_10_28/0.75)_38%,transparent_75%)]" />
        <div className="mx-auto max-w-[1120px] px-4 pb-12 pt-32 sm:px-8 sm:pb-16 sm:pt-40">
          <p data-intro="fade" className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-[#8fb0ff]">Real-world assets, made fluid</p>
          <h1 data-intro="title" className="mt-5 text-[58px] font-semibold leading-[0.94] tracking-[-0.05em] sm:text-[96px]">
            Let them trade.
            <span className="block text-[#6f9bff]">You earn.</span>
          </h1>
          <p data-intro="fade" className="mt-7 max-w-[56ch] text-pretty text-[19px] text-white/70">
            Earn from weekend trading, without trading. River puts your tokenized stocks where the weekend trades happen,
            <strong className="font-semibold text-white"> only while Wall Street is closed</strong>, and brings them back to your
            wallet before it opens.
          </p>
          <div data-intro="fade" className="mt-9 flex flex-wrap gap-3">
            <Link to="/connect/binance" className={btn.primary}>Connect Binance Wallet</Link>
            <a href="#proof" className={ghost}>See the proof</a>
          </div>
          <div data-intro="fade" className="mt-16 sm:mt-24">
            <TideGauge window={w} entry={w.start + SIGNAL_DEFAULTS.settleMs} exit={w.end - SIGNAL_DEFAULTS.exitBufferMs} serverNow={d.now} />
          </div>
        </div>
      </section>
      <WaveEdge above={WATER} below={LAND} />

      {/* ── land: the two facts ── */}
      <section className="mt-16 grid gap-14 lg:grid-cols-2 lg:gap-12" aria-label="Why weekends">
        <div>
          <Beat kick="01 — The edge" title="Their weekend trading pays you.">
            <p>
              Someone is always trading tokenized stocks on weekends. Every trade pays a fee. River puts your shares where
              those trades happen, so you keep holding, do nothing, and earn.
            </p>
          </Beat>
          <div className="mt-7"><Figure value={3.7} prefix="$" suffix="M" label="traded on an average weekend, in a single pool" source="one bStock pool · PancakeSwap v3 · Jul–Sep 2026" /></div>
        </div>
        <div>
          <Beat kick="02 — The clock" title="The market closes. The chain doesn't.">
            <p>
              From Friday night to Sunday night the NYSE is closed, but bStocks keep trading on-chain. With no news, the
              price drifts sideways, and every trade still pays a fee.
            </p>
          </Beat>
          <div className="mt-7"><Figure value={2.9} suffix="%" label="48 h price range on weekends, against 5.8% on weekdays" source="NVDAB/USDT · Jul–Sep 2026" /></div>
        </div>
      </section>

      {/* ── water: proven ── */}
      <div className="mt-24"><WaveEdge above={LAND} below={WATER} /></div>
      <section id="proof" className="water bleed relative isolate scroll-mt-16 overflow-hidden" aria-labelledby="bt">
        <div aria-hidden className="absolute inset-0 -z-10 [background:radial-gradient(800px_460px_at_85%_100%,rgb(31_91_255/0.28),transparent_65%)]" />
        <Currents className="absolute inset-x-0 bottom-0 -z-10 h-[50%] w-full opacity-70" from={0.2} to={0.9} lines={6} />
        <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-8 sm:py-24">
          <Beat dark kick="03 — Proven" title={<span id="bt">~8–25% a year, on top of your stock.</span>}>
            <p>
              Earned from weekend trading fees, net of impermanent loss, gas and River's fee. Your shares are back before
              the open, so you keep the stock's moves.
            </p>
          </Beat>
          {d.backtest ? (
            <>
              <div className="mt-12 grid gap-4 md:grid-cols-2" data-reveal="stagger">
                {d.backtest.rows.map((r) => (
                  <div key={r.asset} className="rounded-panel border border-white/12 bg-white/[0.045] p-6 backdrop-blur-sm sm:p-8">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-lg font-semibold">{r.asset}</span>
                      <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/55">{r.windows} weekends · {r.winRateBase}% with a gain</span>
                    </div>
                    <div className="tnum condensed mt-6 text-[80px] font-semibold leading-none tracking-[-0.03em] sm:text-[104px]" data-count={r.netAprBase.toFixed(1)} data-suffix="%">
                      {r.netAprBase.toFixed(1)}%
                    </div>
                    <p className="mt-2 text-white/60">net APR, base case, on ${d.backtest!.sizeUsd.toLocaleString("en-US")}</p>
                    <p className="mt-6 border-t border-white/10 pt-4 font-mono text-[13px] text-white/60">
                      if 4× more liquidity competes: <span className="text-white">{r.netAprOthersX4.toFixed(1)}%</span>
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-10 grid gap-6 text-[15px] text-white/60 md:grid-cols-2" data-reveal="stagger">
                <p>
                  The production signal and planner, replayed over every closed window since each pool launched. Net of{" "}
                  {d.backtest.costs}. With four times the competing liquidity the result drops to {Math.min(...aprs).toFixed(1)}%,
                  which is why we claim about 8–25%.
                </p>
                <p>{d.backtest.control} Caveats: {d.backtest.caveats.join("; ")}.</p>
              </div>
            </>
          ) : (
            <p className="mt-6 text-white/60">The backtest is unavailable right now. The replay lives in the repository under research/gate0.</p>
          )}
        </div>
      </section>
      <WaveEdge above={WATER} below={LAND} />

      {/* ── land: try it, how it runs, the terms, every stock ── */}
      <section className="mt-16" aria-labelledby="simulate">
        <h2 id="simulate" className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">Try it with your own amount</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          Pick a stock River runs and an amount. The replay runs the same code the agent does over every past weekend and
          holiday, so the result is what River would have added after every cost.
        </p>
        <div className="mt-8" data-reveal>
          <Simulator stocks={d.simStocks} initial={d.initialSim} />
        </div>
      </section>

      <section className="mt-28" aria-label="How River places the position">
        <Beat kick="04 — How it runs" title="A tight band where the trades happen.">
          <p>
            River adds your shares and USDT as concentrated liquidity on PancakeSwap v3, sized from how price moved inside
            the last four weekends. Every swap through the band pays you a fee, and on weekends the price rarely leaves it.
          </p>
        </Beat>
        <div className="mt-10">
          <BandSchematic />
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-3" data-reveal="stagger">
          {([
            ["+1 h", "In after the close.", "1 hour after the close, once prints settle, River deposits your shares and USDT into the band."],
            ["μ ± 2σ", "Measured, not guessed.", <>The band is <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer" className={btn.link}>IVL</a>'s μ ± 2σ over the last four weekends, each rebased to its own start. Nothing is swapped.</>],
            ["−2 h", "Out before the open.", "2 hours before the reopen, River withdraws. Your position comes back to your wallet, plus the fees."],
          ] as [string, string, ReactNode][]).map(([mark, title, body]) => (
            <li key={title} className="bg-solid p-6">
              <span className="font-mono text-[13px] font-semibold text-river">{mark}</span>
              <h3 className="mt-2 text-[20px] font-semibold leading-snug">{title}</h3>
              <p className="mt-2 text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-28 grid gap-14 lg:grid-cols-2 lg:gap-12" aria-label="Safe, and on your terms">
        <Beat kick="05 — Safe by design" title="We never touch your funds.">
          <p>
            Everything runs from your own wallet, so you don't have to trust us. River's agent can only move your shares
            into the pool and back. Binance checks every move first, and anything else is refused.
          </p>
          <p>No vault and no River contract: the position is minted to your wallet.</p>
        </Beat>
        <Beat kick="06 — On your terms" title="Weekly, or on autopilot for months.">
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

      <section className="mt-28" aria-labelledby="stocks">
        <h2 id="stocks" className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">Every tokenized stock on BNB Chain</h2>
        <p className="mt-2 max-w-[64ch] text-ink-2">
          {d.tokens} tokens from bStocks and Ondo, covering {d.stocks.length} companies and funds, synced from Binance every
          15 minutes. Every day River looks for each one's PancakeSwap pool against USDT and replays its past weekends;
          a stock that consistently adds to its holders after every cost is switched on by itself.
        </p>
        <div className="mt-8" data-reveal>
          <StockCatalog rows={d.stocks} />
        </div>
      </section>

      {/* ── water: River as an agent, and the close ── */}
      <div className="mt-24"><WaveEdge above={LAND} below={WATER} /></div>
      <section className="water bleed relative isolate overflow-hidden" aria-label="River for agents, and start">
        <div aria-hidden className="absolute inset-0 -z-10 [background:radial-gradient(900px_520px_at_50%_100%,rgb(31_91_255/0.38),transparent_65%)]" />
        <Currents className="absolute inset-x-0 bottom-0 -z-10 h-[62%] w-full" from={0.25} to={0.95} lines={9} />
        <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <Beat dark kick="07 — River is an agent too" title="Other agents hire it.">
              <p>River is ERC-8004 agent #365864 on BNB Chain. Any agent can buy its weekend plan for $0.10 over x402 or MCP.</p>
            </Beat>
            <Link to="/agent" className={ghost}>River for agents</Link>
          </div>
          <div className="mt-24 text-center sm:mt-32" data-reveal="stagger">
            <h2 className="text-[48px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[84px]">
              Hold your stocks.
              <span className="block text-[#6f9bff]">Let the weekend pay.</span>
            </h2>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link to="/connect/binance" className={btn.primary}>Connect Binance Wallet</Link>
              <Link to="/connect/altana" className={ghost}>Use any other wallet</Link>
            </div>
          </div>
        </div>
      </section>
      <div className="-mb-24"><WaveEdge above={WATER} below={LAND} /></div>
    </>
  );
}
