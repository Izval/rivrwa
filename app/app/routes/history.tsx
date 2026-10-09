// history.tsx — every closed cycle: shares in and out, fees, impermanent loss, River's fee and gas, with the three
// transactions on BscScan. This is the proof the product promises, so every number comes from the cycle record.

import { Link, redirect } from "react-router";
import type { Route } from "./+types/history";
import { me } from "../lib/agent.server.ts";
import { requireOwner, signOut } from "../lib/session.server.ts";
import { EmptyState, Panel, Stat, btn } from "../components/ui.tsx";
import { bscscanTx, dayLabel, num, shares, usd } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [{ title: "History | River" }];

export async function loader({ request }: Route.LoaderArgs) {
  const owner = await requireOwner(request);
  const account = await me(owner);
  if (!account) throw redirect("/connect/binance", { headers: { "set-cookie": await signOut(request) } });
  const cycles = account.mandates.flatMap((m) => m.cycles).sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  return { cycles, hasMandate: account.mandates.length > 0 };
}

const EXIT: Record<string, string> = { window_closing: "Left before the reopen", drift: "Left early: price drifted", mandate_expired: "Left at the end of the mandate", event: "Left for a corporate event", manual: "Left when you asked" };

export default function History({ loaderData: { cycles, hasMandate } }: Route.ComponentProps) {
  const fees = cycles.reduce((a, c) => a + c.feesUsd, 0);
  const net = cycles.reduce((a, c) => a + c.feesUsd - c.riverFeeUsd - c.ilUsd, 0);
  const gas = cycles.reduce((a, c) => a + c.gasBnb, 0);
  return (
    <>
      <h1 className="condensed text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">History</h1>
      {cycles.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No cycles yet"
            hint={hasMandate ? "Your first cycle appears here after River leaves the pool at the end of the next closed window." : "Set a mandate and activate it; each weekend it runs appears here with its transactions."}
            action={<Link to={hasMandate ? "/dashboard" : "/mandate"} className={btn.primary}>{hasMandate ? "Go to the dashboard" : "Set a mandate"}</Link>}
          />
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat label="Cycles" value={cycles.length} />
            <Stat label="LP fees earned" value={usd(fees)} />
            <Stat label="Net of IL and River's fee" value={usd(net)} tone={net > 0 ? "up" : net < 0 ? "down" : undefined} />
            <Stat label="Gas paid" value={`${num(gas, 4)} BNB`} />
          </div>
          <div className="mt-10 space-y-4">
            {cycles.map((c) => {
              const dShares = c.sharesAfter - c.sharesBefore;
              return (
                <Panel as="article" key={c.txs.remove} className="p-5 sm:p-6">
                  <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <h2 className="text-lg font-semibold">{c.asset}</h2>
                    <span className="text-ink-2">{dayLabel(c.openedAt.slice(0, 10))} to {dayLabel(c.closedAt.slice(0, 10))}</span>
                    <span className="text-[14px] text-ink-3">{EXIT[c.exitReason] ?? c.exitReason}</span>
                  </header>
                  <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
                    <Stat
                      label="Shares"
                      value={`${shares(c.sharesBefore)} → ${shares(c.sharesAfter)}`}
                      hint={`${dShares >= 0 ? "+" : "−"}${shares(Math.abs(dShares))} sh`}
                    />
                    <Stat label="Fees" value={usd(c.feesUsd)} hint={`${shares(c.fees.stock)} sh + ${usd(c.fees.usd)}`} tone={c.feesUsd > 0 ? "up" : undefined} />
                    <Stat label="Impermanent loss" value={usd(c.ilUsd)} hint="vs holding the same tokens" />
                    <Stat label="River's fee" value={usd(c.riverFeeUsd)} />
                    <Stat label="Gas" value={`${num(c.gasBnb, 5)} BNB`} hint={`entry ${usd(c.entryPrice)}, exit ${usd(c.exitPrice)}`} />
                  </div>
                  <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
                    <a href={bscscanTx(c.txs.add)} target="_blank" rel="noreferrer" className={btn.link}>Deposit</a>
                    {c.txs.claim && <a href={bscscanTx(c.txs.claim)} target="_blank" rel="noreferrer" className={btn.link}>Fee claim</a>}
                    <a href={bscscanTx(c.txs.remove)} target="_blank" rel="noreferrer" className={btn.link}>Withdrawal</a>
                    <span className="text-ink-3">Position NFT #{c.nftId}</span>
                  </p>
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
