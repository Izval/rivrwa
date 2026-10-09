// dashboard.tsx — the live view of one account: where the market clock stands, whether River can still sign (the
// Binance pass), and for each mandate what the agent is doing, where its band sits against the price, and what it
// did lately. Every control here is a mandate change; the agent reads the result on its next 5-minute tick.
// Before a window, each card also loads a readiness checklist (dashboard.preflight.ts) and can rehearse the entry.

import { useEffect, useState } from "react";
import { useFetcher, Link, redirect } from "react-router";
import type { Route } from "./+types/dashboard";
import { clockState } from "../../../packages/core/src/clock.ts";
import { SIGNAL_DEFAULTS } from "../../../packages/core/src/signal.ts";
import {
  AgentError, altanaRevoke, disconnect, me, preview, rehearse, requestExit, resume, setStatus, telegramLink, type AltanaView, type MandateView, type Me,
  type PreflightItem,
} from "../lib/agent.server.ts";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { assets, signal, type Signal } from "../lib/api.server.ts";
import type { loader as preflightLoader } from "./dashboard.preflight.ts";
import { requireOwner, signOut } from "../lib/session.server.ts";
import { WeekStrip } from "../components/WeekStrip.tsx";
import { BandChart } from "../components/BandChart.tsx";
import { Countdown } from "../components/Countdown.tsx";
import { EmptyState, Notice, Panel, Pill, Stat, btn } from "../components/ui.tsx";
import { profileOf } from "../lib/profiles.ts";
import { bscscanAddr, bscscanTx, duration, pct, shares, shortAddr, usd, when } from "../lib/format.ts";

export const meta: Route.MetaFunction = () => [{ title: "Dashboard | River" }];

export async function loader({ request }: Route.LoaderArgs) {
  const owner = await requireOwner(request);
  const account = await me(owner);
  if (!account) throw redirect("/connect/binance", { headers: { "set-cookie": await signOut(request) } });
  const now = Date.now();
  const [sigs, registry] = await Promise.all([Promise.all(account.mandates.map((m) => signal(m.asset))), assets()]);
  const signals: Record<string, Signal | null> = Object.fromEntries(account.mandates.map((m, i) => [m.asset, sigs[i]]));
  // Suggest a second stock when the account runs only one: pinned ones first, then anything the gate enabled.
  const taken = new Set(account.mandates.map((m) => m.asset));
  const pool = (registry ?? []).filter((a) => a.enabled && !taken.has(a.symbol));
  const next = account.mandates.length === 1 ? (pool.find((a) => a.source === "pinned") ?? pool[0])?.symbol ?? null : null;
  // Token addresses for flow B's withdraw: the account's stocks first, then every enabled one.
  const tokens = Object.fromEntries((registry ?? ASSETS).map((a) => [a.symbol, a.token]));
  const withdrawable = [...new Set([...account.mandates.map((m) => m.asset), ...(registry ?? ASSETS).filter((a) => a.enabled).map((a) => a.symbol)])]
    .filter((sym) => tokens[sym]).map((symbol) => ({ symbol, token: tokens[symbol] }));
  return { now, clock: clockState(now), account, signals, next, withdrawable };
}

export async function action({ request }: Route.ActionArgs) {
  const owner = await requireOwner(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  const asset = String(f.get("asset") ?? "");
  try {
    if (intent === "preview") return { intent, asset, outcome: await preview(owner, asset), telegramUrl: null, error: null };
    if (intent === "rehearse") return { intent, asset, outcome: await rehearse(owner, asset), telegramUrl: null, error: null };
    if (intent === "resume") {
      await resume(owner, asset);
      return { intent, asset, outcome: null, telegramUrl: null, error: null };
    }
    if (intent === "activate" || intent === "pause") {
      await setStatus(owner, asset, intent === "activate" ? "active" : "paused");
      return { intent, asset, outcome: null, telegramUrl: null, error: null };
    }
    if (intent === "exit") {
      const { requested } = await requestExit(owner, asset);
      return { intent, asset, outcome: null, telegramUrl: null, error: requested ? null : "There is no open position, or River is already leaving it." };
    }
    if (intent === "telegram") return { intent, asset, outcome: null, telegramUrl: (await telegramLink(owner)).url, error: null };
    if (intent === "altana-revoke") {
      await altanaRevoke(owner);
      return { intent, asset, outcome: null, telegramUrl: null, error: null };
    }
    if (intent === "disconnect") {
      await disconnect(owner);
      return redirect("/", { headers: { "set-cookie": await signOut(request) } });
    }
    return { intent, asset, outcome: null, telegramUrl: null, error: "Unknown action." };
  } catch (e) {
    const msg = e instanceof AgentError ? e.message : `The agent did not answer (${(e as Error).message}).`;
    return { intent, asset, outcome: null, telegramUrl: null, error: msg };
  }
}

export default function Dashboard({ loaderData: d }: Route.ComponentProps) {
  const w = d.clock.window;
  const entry = w.start + SIGNAL_DEFAULTS.settleMs, exit = w.end - SIGNAL_DEFAULTS.exitBufferMs;
  const [label, target] =
    d.now < w.start ? ["The next closed window starts in", w.start]
    : d.now < entry ? ["River enters the pool in", entry]
    : d.now < exit ? ["River leaves the pool in", exit]
    : ["The market reopens in", w.end];
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel className="p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <p className="text-[15px] text-ink-2">{label}</p>
              <Countdown to={target} serverNow={d.now} className="condensed block text-[44px] font-semibold leading-none tracking-[-0.02em]" />
            </div>
            <Pill tone={d.clock.phase === "closed_window" ? "river" : "muted"} live={d.clock.phase === "closed_window"}>
              {d.clock.phase === "closed_window" ? "NYSE closed" : "NYSE open"}
            </Pill>
          </div>
          <div className="mt-5">
            <WeekStrip window={w} serverNow={d.now} compact />
          </div>
        </Panel>
        {d.account.user.kind === "altana" && d.account.altana ? <AltanaPanel account={d.account} view={d.account.altana} now={d.now} /> : <PassPanel account={d.account} now={d.now} />}
      </div>

      <div className="mt-12 flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Your mandates</h1>
        <div className="flex flex-wrap gap-3">
          {d.next && <Link to={`/mandate?asset=${d.next}`} className={btn.quiet}>Add {d.next}</Link>}
          {d.account.mandates.length > 0 && <Link to="/mandate" className={btn.quiet}>Add or edit a mandate</Link>}
        </div>
      </div>
      <div className="mt-6 space-y-6">
        {d.account.mandates.length === 0 ? (
          <EmptyState
            title="Set your first mandate"
            hint="Choose which stock River may put to work, how much of it, and how tight the band may get. It starts paused, so you can preview before anything is sent."
            action={<Link to="/mandate" className={btn.primary}>Set a mandate</Link>}
          />
        ) : (
          d.account.mandates.map((m) => <MandateCard key={m.id} m={m} signal={d.signals[m.asset] ?? null} />)
        )}
      </div>

      {d.account.user.kind === "altana" && d.account.altana
        ? <AltanaDangerZone view={d.account.altana} stocks={d.withdrawable} />
        : <DangerZone />}
    </>
  );
}

function TelegramButton({ linked }: { linked: boolean }) {
  const tg = useFetcher<typeof action>();
  if (linked) return <span className="inline-flex min-h-11 items-center text-[15px] text-ink-2">Telegram alerts on</span>;
  if (tg.data?.telegramUrl) return <a href={tg.data.telegramUrl} target="_blank" rel="noreferrer" className={btn.quiet}>Open Telegram to finish</a>;
  return (
    <tg.Form method="post">
      <button name="intent" value="telegram" className={btn.quiet} disabled={tg.state !== "idle"}>Get Telegram alerts</button>
    </tg.Form>
  );
}

/** Flow B: the Altana session River signs with, its end, and the account it acts on. */
function AltanaPanel({ account, view, now }: { account: Me; view: AltanaView; now: number }) {
  const until = view.expiresAt;
  const live = account.session.connected;
  const soon = live && until !== null && until - now < 7 * 86_400_000;
  return (
    <Panel className="flex flex-col p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Altana session</h2>
        <Pill tone={!live ? "down" : soon ? "warn" : "up"}>{view.state === "revoked" ? "Revoked" : !live ? "Ended" : soon ? "Ending soon" : "Active"}</Pill>
      </div>
      <p className="mt-2 text-[15px] text-ink-2">
        {live && until
          ? <>River can sign until <span className="tnum font-semibold text-ink">{when(until)}</span> ({duration(until - now)} left), only on PancakeSwap's position manager and within the weekly caps you set.</>
          : "River cannot sign for this account. Grant a new session to resume."}
      </p>
      <p className="mt-2 text-[14px] text-ink-3">
        Account <a href={bscscanAddr(view.account)} target="_blank" rel="noreferrer" className={btn.link}>{shortAddr(view.account)}</a>
        {view.grantTx && <> · <a href={bscscanTx(view.grantTx)} target="_blank" rel="noreferrer" className={btn.link}>grant</a></>}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/connect/altana?renew=1" className={soon || !live ? btn.primary : btn.quiet}>Renew session</Link>
        <TelegramButton linked={account.user.telegram} />
      </div>
      <p className="mt-auto pt-4 text-[13px] text-ink-3">
        Your passkey controls the account. River's server keeps only the session key, encrypted, and checks every call
        before it signs.
      </p>
    </Panel>
  );
}

function PassPanel({ account, now }: { account: Me; now: number }) {
  const s = account.session;
  const cap = s.expiresAt ?? null, idle = s.idleExpiresAt ?? null;
  const until = cap && idle ? Math.min(cap, idle) : cap ?? idle;
  const soon = until !== null && until - now < 24 * 3_600_000;
  return (
    <Panel className="flex flex-col p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Binance pass</h2>
        <Pill tone={!s.connected ? "down" : soon ? "warn" : "up"}>{!s.connected ? "Not connected" : soon ? "Expiring" : "Active"}</Pill>
      </div>
      {s.connected ? (
        <p className="mt-2 text-[15px] text-ink-2">
          {until ? <>River can sign until <span className="tnum font-semibold text-ink">{when(until)}</span> ({duration(until - now)} left).</> : "River is reading the expiry from Binance."}
          {" "}Every action River takes extends the idle limit, up to Binance's 7-day cap.
        </p>
      ) : (
        <p className="mt-2 text-[15px] text-ink-2">River cannot sign for this wallet. Pair it again to resume.</p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/connect/binance" className={soon || !s.connected ? btn.primary : btn.quiet}>Renew pass</Link>
        <TelegramButton linked={account.user.telegram} />
      </div>
      <p className="mt-auto pt-4 text-[13px] text-ink-3">
        River's server keeps your Binance session encrypted so it can act while you are away. It works only within the
        limits you set in the Binance App.
      </p>
    </Panel>
  );
}

function stateLine(m: MandateView): { tone: "river" | "down" | "muted" | "warn"; text: string } {
  const s = m.state;
  if (s.halted) return { tone: "down", text: `Halted: ${s.halted}. River sends nothing until this is cleared.` };
  if (s.pending) return { tone: "river", text: `Waiting for the ${s.pending.kind} transaction to confirm.` };
  if (s.exit) return { tone: "river", text: `Leaving the pool (${s.exit.reason}).` };
  if (s.position) return { tone: "river", text: `In the pool since ${when(s.position.openedAt)}.` };
  if (m.status === "paused") return { tone: "muted", text: "Paused. River will not enter until you activate this mandate." };
  const last = m.ticks[0];
  return { tone: "muted", text: last ? `Last check ${when(last.at)}: ${last.note}` : "Active. River checks every 5 minutes and enters when the next window opens." };
}

function MandateCard({ m, signal }: { m: MandateView; signal: Signal | null }) {
  const f = useFetcher<typeof action>();
  const busy = f.state !== "idle" ? String(f.formData?.get("intent") ?? "") : null;
  const res = f.data && f.data.asset === m.asset ? f.data : null;
  const p = m.params;
  const profile = profileOf(p.maxHalfWidth, p.exitOnDrift);
  const pos = m.state.position;
  const line = stateLine(m);
  const fees = m.cycles.reduce((a, c) => a + c.feesUsd, 0);
  const active = m.status === "active";
  return (
    <Panel as="article" className="p-5 sm:p-7">
      <header className="flex flex-wrap items-center gap-3">
        <h2 id={m.asset} className="text-2xl font-semibold tracking-[-0.01em]">{m.asset}</h2>
        <Pill tone={active ? "river" : "muted"} live={active}>{active ? "Active" : "Paused"}</Pill>
        <div className="ml-auto flex flex-wrap gap-2">
          <f.Form method="post">
            <input type="hidden" name="asset" value={m.asset} />
            <button name="intent" value="preview" className={btn.quiet} disabled={!!busy}>
              {busy === "preview" ? "Simulating…" : "Preview next step"}
            </button>
          </f.Form>
          <f.Form method="post">
            <input type="hidden" name="asset" value={m.asset} />
            <button name="intent" value={active ? "pause" : "activate"} className={active ? btn.quiet : btn.primary} disabled={!!busy}>
              {busy === "activate" ? "Activating…" : busy === "pause" ? "Pausing…" : active ? "Pause" : "Activate"}
            </button>
          </f.Form>
        </div>
      </header>
      <p className={`mt-3 text-[15px] ${line.tone === "down" ? "font-semibold text-down" : line.tone === "river" ? "text-river-deep" : "text-ink-2"}`}>{line.text}</p>
      {m.state.halted && (
        <f.Form method="post" className="mt-3">
          <input type="hidden" name="asset" value={m.asset} />
          <button name="intent" value="resume" className={btn.primary} disabled={!!busy}>{busy === "resume" ? "Resuming…" : "I fixed it, resume"}</button>
        </f.Form>
      )}

      {busy === "preview" && <div className="shimmer mt-4 h-12 rounded-control" aria-label="Simulating the next step" />}
      {res?.outcome && (
        <div className="mt-4">
          <Notice>
            <span className="font-semibold text-ink">{res.intent === "rehearse" ? "Rehearsal" : "Dry run"}: {res.outcome.kind}.</span> {res.outcome.note} Nothing was sent.
          </Notice>
        </div>
      )}
      {res?.error && <div className="mt-4"><Notice tone="down">{res.error}</Notice></div>}

      {!pos && !m.state.exit && <Readiness asset={m.asset} busy={busy} fetcher={f} />}

      <div className="mt-6">
        {signal ? (
          <BandChart price={signal.price} band={signal.band} range={pos?.range ?? null} entryPrice={pos?.entryPrice ?? null} />
        ) : (
          <p className="text-[15px] text-ink-3">The live signal is unavailable right now; the agent keeps its own copy.</p>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
        <Stat label="Allocation" value={pct(p.allocation, 0)} hint={`of your ${m.asset} and USDT`} />
        <Stat label="Profile" value={profile?.name ?? "Custom"} hint={`band up to ±${pct(p.maxHalfWidth)}, leave at ${pct(p.exitOnDrift)} drift`} />
        {pos ? (
          <Stat label="In the position" value={`${shares(pos.entryAmounts.stock)} sh`} hint={`+ ${usd(pos.entryAmounts.usd)} USDT`} />
        ) : (
          <Stat label="Cycles completed" value={m.cycles.length} />
        )}
        <Stat label="Fees earned" value={usd(fees)} hint={m.cycles.length ? <Link to="/history" className={btn.link}>See history</Link> : "no cycles yet"} />
      </div>
      {pos && (
        <p className="mt-4 text-[13px] text-ink-3">
          Position NFT #{pos.nftId}, range {usd(pos.range.priceLow)} to {usd(pos.range.priceHigh)}.{" "}
          <a href={bscscanTx(pos.entry.addTx)} target="_blank" rel="noreferrer" className={btn.link}>Deposit transaction</a>
        </p>
      )}
      {pos && !m.state.exit && (
        <f.Form method="post" className="mt-3">
          <input type="hidden" name="asset" value={m.asset} />
          <button name="intent" value="exit" className={btn.quiet} disabled={!!busy}>{busy === "exit" ? "Asking River to leave…" : "Leave the pool now"}</button>
          <span className="ml-3 text-[13px] text-ink-3">River withdraws on its next run (within 5 minutes) and closes the cycle.</span>
        </f.Form>
      )}
      {pos && m.state.exit && <p className="mt-3 text-[14px] text-ink-2">River is leaving the pool ({m.state.exit.reason === "manual" ? "you asked" : m.state.exit.reason}).</p>}

      {m.ticks.length > 0 && (
        <details className="mt-5 border-t border-line pt-4">
          <summary className="cursor-pointer text-[15px] font-semibold text-ink-2 hover:text-ink">Recent activity ({m.ticks.length})</summary>
          <ol className="mt-3 space-y-2">
            {m.ticks.slice(0, 12).map((t) => (
              <li key={t.at + t.kind} className="grid grid-cols-[120px_1fr] gap-3 text-[14px] sm:grid-cols-[170px_90px_1fr]">
                <span className="tnum text-ink-3">{when(t.at).replace(" UTC", "")}</span>
                <span className="hidden font-semibold sm:block">{t.kind}</span>
                <span className="text-ink-2">{t.note}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </Panel>
  );
}

const MARK: Record<PreflightItem["level"], { sign: string; cls: string }> = {
  ok: { sign: "✓", cls: "text-up" },
  warn: { sign: "!", cls: "text-warn" },
  fail: { sign: "✕", cls: "text-down" },
};

/**
 * The next window's checklist. It loads once the card mounts and again after any action of the card settles
 * (a rehearsal, an activation or a resume changes its answers).
 */
function Readiness({ asset, busy, fetcher: f }: {
  asset: string; busy: string | null; fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  const pf = useFetcher<typeof preflightLoader>();
  useEffect(() => {
    if (f.state === "idle") pf.load(`/dashboard/preflight/${asset}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, f.state]);
  const p = pf.data?.preflight ?? null;
  const loading = pf.state !== "idle" && !p;
  return (
    <section className="mt-5 rounded-control border border-line bg-solid/60 p-4 sm:p-5" aria-label={`${asset} readiness`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[15px] font-semibold">Ready for the next window?</h3>
        {p && <Pill tone={p.ready ? "up" : "down"}>{p.ready ? "Ready" : "Not ready"}</Pill>}
        {p && <span className="text-[13px] text-ink-3">enters {when(p.entryAt)}, leaves {when(p.exitAt)}</span>}
        <f.Form method="post" className="ml-auto">
          <input type="hidden" name="asset" value={asset} />
          <button name="intent" value="rehearse" className={btn.quiet} disabled={!!busy}>{busy === "rehearse" ? "Rehearsing…" : "Rehearse the entry"}</button>
        </f.Form>
      </div>
      {loading && <div className="shimmer mt-4 h-24 rounded-control" aria-label="Checking" />}
      {pf.data?.error && <p className="mt-3 text-[14px] text-ink-3">{pf.data.error}</p>}
      {p && (
        <ul className="mt-3 space-y-2">
          {p.items.map((i) => (
            <li key={i.id} className="grid grid-cols-[20px_1fr] gap-2 text-[14px]">
              <span aria-label={i.level} className={`font-semibold ${MARK[i.level].cls}`}>{MARK[i.level].sign}</span>
              <span>
                <span className="font-semibold text-ink">{i.label}.</span> <span className="text-ink-2">{i.detail}</span>
                {i.id === "session" && i.level !== "ok" && <> <Link to="/connect/binance" className={btn.link}>Renew</Link></>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DangerZone() {
  return (
    <details className="mt-16 max-w-xl">
      <summary className="cursor-pointer text-[15px] font-semibold text-ink-2 hover:text-ink">Disconnect Binance</summary>
      <div className="mt-3">
        <p className="text-[15px] text-ink-2">
          River signs out of your Agentic Wallet and deletes the stored session. Open positions stay in your wallet;
          close them from the Binance App or pair again to let River finish the cycle.
        </p>
        <form method="post" className="mt-4">
          <button name="intent" value="disconnect" className={`${btn.quiet} hover:!border-down hover:!text-down`}>Disconnect and sign out</button>
        </form>
      </div>
    </details>
  );
}

/**
 * Flow B's exits. "Stop River" deletes River's key on the server at once (no passkey needed). "Revoke on-chain" also
 * removes it from the account with the passkey. "Withdraw" sends the whole stock and USDT balance anywhere.
 */
function AltanaDangerZone({ view, stocks }: { view: AltanaView; stocks: { symbol: string; token: string }[] }) {
  const f = useFetcher<typeof action>();
  const [to, setTo] = useState("");
  const [stock, setStock] = useState(stocks[0]?.symbol ?? "");
  const [note, setNote] = useState<{ tone: "muted" | "down"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const passkey = { id: view.passkey.id, publicKey: view.passkey.publicKey, rpId: view.passkey.rpId };
  const token = stocks.find((s) => s.symbol === stock)?.token ?? "";
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setNote(null);
    try { setNote({ tone: "muted", text: await fn() }); }
    catch (e) { setNote({ tone: "down", text: (e as Error).name === "NotAllowedError" ? "The passkey prompt was dismissed." : (e as Error).message }); }
    finally { setBusy(null); }
  };
  const revokeOnchain = () => run("revoke", async () => {
    if (!view.sessionPubkey) throw new Error("There is no session key to revoke.");
    const { revokeOnchain } = await import("../lib/altana.client.ts");
    const tx = await revokeOnchain(view.account, passkey, view.sessionPubkey);
    f.submit({ intent: "altana-revoke" }, { method: "post" });
    return `River's key is revoked on-chain${tx ? ` (tx ${tx.slice(0, 10)}…)` : ""} and deleted from River's server. Mandates are paused.`;
  });
  const withdraw = () => run("withdraw", async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Enter a BSC address to send to.");
    const { withdrawAll } = await import("../lib/altana.client.ts");
    const tx = await withdrawAll(view.account, passkey, token, to);
    return `Sent your ${stock} and USDT to ${shortAddr(to)}${tx ? ` (tx ${tx.slice(0, 10)}…)` : ""}.`;
  });
  return (
    <details className="mt-16 max-w-xl">
      <summary className="cursor-pointer text-[15px] font-semibold text-ink-2 hover:text-ink">Stop River or withdraw</summary>
      <div className="mt-3 space-y-6">
        <div>
          <p className="text-[15px] text-ink-2">
            Stopping deletes River's session key from its server and pauses every mandate. An open position stays in your
            account; withdraw it yourself or grant a new session to let River finish the cycle.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <f.Form method="post">
              <button name="intent" value="altana-revoke" className={`${btn.quiet} hover:!border-down hover:!text-down`} disabled={f.state !== "idle" || !!busy}>Stop River</button>
            </f.Form>
            <button className={`${btn.quiet} hover:!border-down hover:!text-down`} onClick={revokeOnchain} disabled={!!busy || !view.sessionPubkey}>
              {busy === "revoke" ? "Waiting for your passkey…" : "Revoke on-chain too"}
            </button>
          </div>
        </div>
        <div>
          <p className="text-[15px] font-semibold">Withdraw</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <select value={stock} onChange={(e) => setStock(e.target.value)} className="min-h-11 rounded-control border border-line bg-solid px-3 text-[15px]">
              {stocks.map((s) => <option key={s.symbol}>{s.symbol}</option>)}
            </select>
            <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x… destination on BSC" className="min-h-11 min-w-0 flex-1 rounded-control border border-line bg-solid px-3 font-mono text-[14px]" />
            <button className={btn.quiet} onClick={withdraw} disabled={!!busy}>{busy === "withdraw" ? "Waiting for your passkey…" : "Withdraw all"}</button>
          </div>
          <p className="mt-2 text-[13px] text-ink-3">Sends the whole {stock} and USDT balance. A position in the pool must be closed first.</p>
        </div>
        {note && <Notice tone={note.tone}>{note.text}</Notice>}
      </div>
    </details>
  );
}
