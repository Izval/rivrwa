// agent.tsx — River seen as an agent rather than an app: its ERC-8004 identity on BSC, what other agents can buy
// from it, and how to call it over x402 or MCP. Three steps, two code samples, one list of the Binance modules
// behind it. Solid cards and dark code blocks, so each part reads at a glance. Public: nothing here needs a login.

import type { Route } from "./+types/agent";
import { agent } from "../lib/api.server.ts";
import type { ReactNode } from "react";
import { EmptyState, btn } from "../components/ui.tsx";
import { useScrollReveal } from "../components/useScrollReveal.ts";
import { bscscanAddr, bscscanTx, dayLabel, shortAddr, usd } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [
  { title: "River, the agent | River" },
  { name: "description", content: "River's ERC-8004 identity on BNB Chain and the weekend plan other agents buy from it over x402 or MCP." },
];

export async function loader() {
  return { a: await agent() };
}

const API = "https://api.rivrwa.com";
const CURL = `curl -i "${API}/v1/paid/plan?symbol=NVDAB&stock=1&usd=250"
# 402 → PAYMENT-REQUIRED lists the rails. Pay, then retry with one of:
#   -H "PAYMENT-SIGNATURE: <base64 x402 v2 payload>"   (b402, gasless)
#   -H "X-PAYMENT-TX: 0x<your USDT transfer to payTo>"`;
const MCP = `{
  "mcpServers": {
    "river": { "type": "http", "url": "${API}/mcp" }
  }
}`;

const BINANCE = [
  ["RWA Data", "the catalog of every tokenized stock on BSC, prices and share ratios"],
  ["DeFi", "each stock's PancakeSwap v3 pool (investment list and detail), lp-add, lp-remove and positions"],
  ["Transaction", "simulate dry-runs every call before River signs it; gas price for the readiness check"],
  ["Market", "token candles back the signal up when the pool's own feed is down; live prices"],
  ["b402", "settles what other agents pay for River's plan (x402 v2, Binance as facilitator)"],
  ["Agentic Wallet", "flow A: River signs from your own Binance wallet under a weekly pass"],
] as const;

const card = "rounded-panel border border-line bg-solid shadow-[0_1px_2px_rgb(14_23_38/0.05)]";
const code = "whitespace-pre-wrap break-all rounded-control bg-ink p-4 font-mono text-[12.5px] leading-relaxed text-[#dbe4ff]";
const kick = "font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-river";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className={`${card} p-6`}>
      <span className="tnum flex size-8 items-center justify-center rounded-full bg-river text-[15px] font-semibold text-white">{n}</span>
      <h3 className="mt-4 text-[20px] font-semibold leading-snug">{title}</h3>
      <div className="mt-2 text-ink-2">{children}</div>
    </li>
  );
}

export default function Agent({ loaderData: { a } }: Route.ComponentProps) {
  const id = a?.identity.agentId ?? null;
  useScrollReveal();
  return (
    <>
      <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-river">For agents</p>
      <h1 className="mt-3 text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[60px]">
        River is an agent too.
        <span className="block text-river">Other agents hire it.</span>
      </h1>
      <p className="mt-5 max-w-2xl text-[18px] text-ink-2">
        River has its own identity on BNB Chain. Any agent can ask it for the weekend window and the band for free, and
        buy a plan fitted to its own wallet for {usd(a?.pricing.planUsd ?? 0.1)}.
      </p>

      {!a ? (
        <div className="mt-8"><EmptyState title="The agent's API did not answer" hint="Try again in a minute." /></div>
      ) : (
        <>
          <ol className="mt-10 grid gap-4 lg:grid-cols-3" data-reveal="stagger">
            <Step n={1} title="Find it on-chain">
              <p>
                ERC-8004 agent <strong className="text-ink">#{id ?? "pending"}</strong> in the BNB Chain identity registry. Its
                registration file lists the endpoints below.
              </p>
            </Step>
            <Step n={2} title="Ask for free">
              <p>The closed window, the stocks River runs, the IVL band for the next window and River's cycle log.</p>
            </Step>
            <Step n={3} title={`Buy the plan for ${usd(a.pricing.planUsd)}`}>
              <p>
                Fitted to <em>your</em> inventory: the band snapped to pool ticks, the deposit that needs no swap and the
                exact Binance lp-add arguments. Paid with {a.pricing.rails.join(" or ")}.
              </p>
            </Step>
          </ol>

          <div className="mt-4 grid gap-4 lg:grid-cols-2" data-reveal="stagger">
            <section className={`${card} min-w-0 p-6`}>
              <p className={kick}>Over HTTP</p>
              <h2 className="mt-1 text-[20px] font-semibold">x402: pay, then call again</h2>
              <pre className={`${code} mt-4`}>{CURL}</pre>
            </section>
            <section className={`${card} min-w-0 p-6`}>
              <p className={kick}>Over MCP</p>
              <h2 className="mt-1 text-[20px] font-semibold">Add River to any MCP client</h2>
              <pre className={`${code} mt-4`}>{MCP}</pre>
              <p className="mt-4 text-[15px] text-ink-2">
                Free: <span className="font-mono text-[13px] text-ink">get_weekend_window, list_assets, get_range, get_cycle_report</span>.
                Paid: <span className="font-mono text-[13px] text-ink">plan_cycle</span>.
              </p>
            </section>
          </div>

          <section className={`${card} mt-4 grid gap-6 p-6 sm:grid-cols-3`} aria-label="Identity" data-reveal>
            <div>
              <p className={kick}>Identity</p>
              <p className="mt-1 text-[20px] font-semibold">ERC-8004 #{id ?? "pending"}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink-2">Registry on BNB Chain</p>
              <p className="mt-1 break-all font-mono text-[13px] text-ink">{a.identity.registry}</p>
            </div>
            <div>
              <p className="text-[13px] font-semibold text-ink-2">Owner wallet</p>
              <p className="mt-1">{a.wallet ? <a className={btn.link} href={bscscanAddr(a.wallet.address)} target="_blank" rel="noreferrer">{shortAddr(a.wallet.address)}</a> : "—"}</p>
              <p className="mt-2 flex gap-4">
                <a className={btn.link} href={a.identity.registration} target="_blank" rel="noreferrer">Registration file</a>
                {a.identity.scan && <a className={btn.link} href={a.identity.scan} target="_blank" rel="noreferrer">8004scan</a>}
              </p>
            </div>
          </section>

          {a.cycles.length > 0 && (
            <>
              <h2 className="mt-14 text-[26px] font-semibold tracking-[-0.02em]">Cycles River has run</h2>
              <div className="mt-4 space-y-3">
                {a.cycles.map((c) => (
                  <article key={c.txs.remove} className={`${card} flex flex-wrap items-baseline gap-x-6 gap-y-2 p-4 sm:p-5`}>
                    <span className="font-semibold">{c.asset}</span>
                    <span className="text-ink-2">{dayLabel(c.openedAt.slice(0, 10))} to {dayLabel(c.closedAt.slice(0, 10))}</span>
                    <span className="font-mono text-[13px] text-ink-2">{c.owner}</span>
                    <span className="ml-auto flex gap-4 text-[14px]">
                      <a href={bscscanTx(c.txs.add)} target="_blank" rel="noreferrer" className={btn.link}>Deposit</a>
                      <a href={bscscanTx(c.txs.remove)} target="_blank" rel="noreferrer" className={btn.link}>Withdrawal</a>
                    </span>
                  </article>
                ))}
              </div>
            </>
          )}

          <h2 className="mt-14 text-[26px] font-semibold tracking-[-0.02em]">Built on the Binance Web3 API</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-reveal="stagger">
            {BINANCE.map(([m, what]) => (
              <div key={m} className={`${card} border-l-4 border-l-river p-5`}>
                <div className="font-semibold text-ink">{m}</div>
                <p className="mt-1 text-[15px] text-ink-2">{what}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
