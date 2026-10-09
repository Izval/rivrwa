// agent.tsx — River seen as an agent rather than an app: its ERC-8004 identity on BSC, what other agents can buy
// from it over x402 or MCP, what it has earned (the treasury that pays its own gas), and every cycle it has run,
// with the transactions. Public on purpose: this page is the proof, so nothing on it needs a login.

import type { Route } from "./+types/agent";
import { agent } from "../lib/api.server.ts";
import { EmptyState, Panel, Pill, Stat, btn } from "../components/ui.tsx";
import { bscscanAddr, bscscanTx, dayLabel, num, shortAddr, usd, when } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [
  { title: "River, the agent | River" },
  { name: "description", content: "River's ERC-8004 identity, its paid plan for other agents (x402, MCP) and every cycle it has run on BSC." },
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

export default function Agent({ loaderData: { a } }: Route.ComponentProps) {
  const id = a?.identity.agentId ?? null;
  return (
    <>
      <p className="text-[15px] font-semibold text-river">For agents</p>
      <h1 className="condensed mt-1 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">River is an agent too</h1>
      <p className="mt-3 max-w-2xl text-[17px] text-ink-2">
        It has its own identity on BNB Chain, sells the plan it trades by to other agents, and pays its own gas from what
        it earns. Everything below is read live from the chain and River's API.
      </p>

      {!a ? (
        <div className="mt-8"><EmptyState title="The agent's API did not answer" hint="Try again in a minute." /></div>
      ) : (
        <>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            <Panel className="p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">Identity</h2>
                {id !== null ? <Pill tone="up">ERC-8004 #{id}</Pill> : <Pill tone="warn">Registration pending</Pill>}
              </div>
              <dl className="mt-4 space-y-3 text-[15px]">
                <div><dt className="text-[13px] text-ink-3">Registry</dt><dd className="break-all font-mono text-[13px]">{a.identity.registry}</dd></div>
                <div>
                  <dt className="text-[13px] text-ink-3">Owner and treasury</dt>
                  <dd>{a.wallet ? <a className={btn.link} href={bscscanAddr(a.wallet.address)} target="_blank" rel="noreferrer">{shortAddr(a.wallet.address)}</a> : "—"}</dd>
                </div>
                <div className="flex gap-4">
                  <a className={btn.link} href={a.identity.registration} target="_blank" rel="noreferrer">Registration file</a>
                  {a.identity.scan && <a className={btn.link} href={a.identity.scan} target="_blank" rel="noreferrer">8004scan</a>}
                </div>
              </dl>
            </Panel>

            <Panel className="p-5 sm:p-6">
              <h2 className="font-semibold">Treasury</h2>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat label="Paid plans" value={a.treasury.paidCalls} />
                <Stat label="Earned" value={usd(a.treasury.revenueUsd)} tone={a.treasury.revenueUsd > 0 ? "up" : undefined} />
                <Stat label="BNB for gas" value={a.wallet?.bnb != null ? num(a.wallet.bnb, 4) : "—"} />
                <Stat label="USDT held" value={a.wallet?.usdt != null ? usd(a.wallet.usdt) : "—"} />
              </div>
            </Panel>

            <Panel className="p-5 sm:p-6">
              <h2 className="font-semibold">What it sells</h2>
              <p className="mt-3 text-[15px] text-ink-2">
                A cycle plan fitted to <em>your</em> inventory, for <strong className="text-ink">{usd(a.pricing.planUsd)}</strong>: the closed
                window, the IVL band snapped to pool ticks, the deposit that needs no swap, and the exact Binance lp-add arguments.
              </p>
              <p className="mt-3 text-[13px] text-ink-3">Paid with {a.pricing.rails.join(" or ")}. The clock, the band and the cycle log stay free.</p>
            </Panel>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel className="p-5 sm:p-6">
              <h2 className="font-semibold">Over HTTP (x402)</h2>
              <pre className="mt-3 overflow-x-auto rounded-control bg-[rgb(14_23_38/0.04)] p-4 font-mono text-[12.5px] leading-relaxed text-ink-2">{CURL}</pre>
            </Panel>
            <Panel className="p-5 sm:p-6">
              <h2 className="font-semibold">Over MCP</h2>
              <pre className="mt-3 overflow-x-auto rounded-control bg-[rgb(14_23_38/0.04)] p-4 font-mono text-[12.5px] leading-relaxed text-ink-2">{MCP}</pre>
              <p className="mt-3 text-[13px] text-ink-3">Tools: get_weekend_window, list_assets, get_range, get_cycle_report (free) and plan_cycle (paid).</p>
            </Panel>
          </div>

          <h2 className="condensed mt-12 text-2xl font-semibold">Cycles River has run</h2>
          {a.cycles.length === 0 ? (
            <div className="mt-4"><EmptyState title="No closed cycle yet" hint="Each cycle appears here, with its transactions on BscScan, as soon as River leaves the pool." /></div>
          ) : (
            <div className="mt-4 space-y-3">
              {a.cycles.map((c) => (
                <Panel as="article" key={c.txs.remove} className="flex flex-wrap items-baseline gap-x-6 gap-y-2 p-4 sm:p-5">
                  <span className="font-semibold">{c.asset}</span>
                  <span className="text-ink-2">{dayLabel(c.openedAt.slice(0, 10))} to {dayLabel(c.closedAt.slice(0, 10))}</span>
                  <span className="font-mono text-[13px] text-ink-3">{c.owner}</span>
                  <span className="tnum">fees {usd(c.feesUsd)}</span>
                  <span className="ml-auto flex gap-4 text-[14px]">
                    <a href={bscscanTx(c.txs.add)} target="_blank" rel="noreferrer" className={btn.link}>Deposit</a>
                    <a href={bscscanTx(c.txs.remove)} target="_blank" rel="noreferrer" className={btn.link}>Withdrawal</a>
                  </span>
                </Panel>
              ))}
            </div>
          )}

          {a.treasury.recent.length > 0 && (
            <>
              <h2 className="condensed mt-12 text-2xl font-semibold">Recent payments</h2>
              <div className="mt-4 space-y-2">
                {a.treasury.recent.map((p, i) => (
                  <div key={p.tx ?? i} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line py-2 text-[15px]">
                    <span className="tnum">{usd(p.usd)}</span>
                    <span className="text-ink-2">{p.rail}</span>
                    <span className="font-mono text-[13px] text-ink-3">{p.payer ? shortAddr(p.payer) : "—"}</span>
                    <span className="text-ink-3">{when(p.at)}</span>
                    {p.tx && <a className={`${btn.link} ml-auto`} href={bscscanTx(p.tx)} target="_blank" rel="noreferrer">Tx</a>}
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 className="condensed mt-12 text-2xl font-semibold">Built on the Binance Web3 API</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BINANCE.map(([m, what]) => (
              <Panel key={m} className="p-4">
                <div className="font-semibold">{m}</div>
                <p className="mt-1 text-[14px] text-ink-2">{what}</p>
              </Panel>
            ))}
          </div>
        </>
      )}
    </>
  );
}
