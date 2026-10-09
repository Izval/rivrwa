// mandate.tsx — the whole policy the agent follows, per asset. A profile sets the two knobs that trade fees for share
// stability; "Advanced" exposes every field of the MandateFile. The agent validates it again (agent/src/mandate.ts),
// so this form only has to make the valid choices easy. A new mandate starts paused; editing keeps its status.

import { useState } from "react";
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/mandate";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { AgentError, me, putMandate, type MandateInput } from "../lib/agent.server.ts";
import { assets as registry } from "../lib/api.server.ts";
import { requireOwner, signOut } from "../lib/session.server.ts";
import { DEFAULT_PROFILE, PROFILES, profileOf } from "../lib/profiles.ts";
import { Notice, Panel, btn } from "../components/ui.tsx";

export const meta: Route.MetaFunction = () => [{ title: "Mandate | River" }];

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function loader({ request }: Route.LoaderArgs) {
  const owner = await requireOwner(request);
  const account = await me(owner);
  if (!account) throw redirect("/connect/binance", { headers: { "set-cookie": await signOut(request) } });
  // The live registry: pinned stocks plus every stock the automatic gate has enabled.
  const live = await registry();
  const assets = (live ?? ASSETS).filter((a) => a.enabled).map((a) => ({ symbol: a.symbol, underlying: a.underlying }));
  const mandates = Object.fromEntries(account.mandates.map((m) => [m.asset, { ...m.params, status: m.status }]));
  return { assets, mandates, today: isoDay(Date.now()) };
}

export async function action({ request }: Route.ActionArgs) {
  const owner = await requireOwner(request);
  const f = await request.formData();
  const n = (k: string) => Number(f.get(k));
  const events = String(f.get("events") ?? "").split(/[\s,]+/).filter(Boolean).map((d) => (d.length === 10 ? `${d}T13:30:00Z` : d));
  const input: MandateInput = {
    asset: String(f.get("asset")),
    allocation: n("allocation") / 100,
    maxHalfWidth: n("maxHalfWidth") / 100,
    exitOnDrift: n("exitOnDrift") / 100,
    slippageBps: Math.round(n("slippageBps")),
    skipEvents: f.get("skipEvents") === "on",
    events,
    restoreShares: false,
    expiresAt: `${String(f.get("expiresAt"))}T${/^\d{2}:\d{2}$/.test(String(f.get("expiresTime"))) ? String(f.get("expiresTime")) : "00:00"}:00Z`,
    status: f.get("status") === "active" ? "active" : "paused",
  };
  try {
    await putMandate(owner, input);
  } catch (e) {
    return { error: e instanceof AgentError ? e.message.replace(/^mandate: /, "") : `The agent did not answer (${(e as Error).message}).` };
  }
  return redirect(`/dashboard#${input.asset}`);
}

export default function Mandate({ loaderData: d, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const first = params.get("asset")?.toUpperCase() ?? Object.keys(d.mandates)[0] ?? d.assets[0].symbol;
  const [asset, setAsset] = useState(d.assets.some((a) => a.symbol === first) ? first : d.assets[0].symbol);
  const saved = d.mandates[asset];
  return (
    <div className="max-w-3xl">
      <h1 className="condensed text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">Your mandate</h1>
      <p className="mt-3 max-w-[60ch] text-lg text-ink-2">
        These rules are everything the agent may do. It checks them on every tick and never acts outside them.
      </p>

      <fieldset className="mt-8">
        <legend className="text-[15px] font-semibold">Stock</legend>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup">
          {d.assets.map((a) => (
            <button
              key={a.symbol} type="button" role="radio" aria-checked={asset === a.symbol} onClick={() => setAsset(a.symbol)}
              className={`min-h-11 rounded-control border px-4 text-left transition-colors ${asset === a.symbol ? "border-river bg-river-mist" : "border-line bg-solid hover:border-river"}`}
            >
              <span className="font-semibold">{a.symbol}</span>
              <span className="ml-2 text-[13px] text-ink-3">{d.mandates[a.symbol] ? (d.mandates[a.symbol].status === "active" ? "active" : "paused") : "not set"}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* Remount per asset so the form starts from that asset's saved mandate. */}
      <MandateForm key={asset} asset={asset} saved={saved ?? null} today={d.today} error={actionData?.error ?? null} />
    </div>
  );
}

type Saved = Route.ComponentProps["loaderData"]["mandates"][string];

function MandateForm({ asset, saved, today, error }: { asset: string; saved: Saved | null; today: string; error: string | null }) {
  const nav = useNavigation();
  const [allocation, setAllocation] = useState(Math.round((saved?.allocation ?? 1) * 100));
  const [knobs, setKnobs] = useState({
    maxHalfWidth: +((saved?.maxHalfWidth ?? DEFAULT_PROFILE.maxHalfWidth) * 100).toFixed(2),
    exitOnDrift: +((saved?.exitOnDrift ?? DEFAULT_PROFILE.exitOnDrift) * 100).toFixed(2),
  });
  const profile = profileOf(knobs.maxHalfWidth / 100, knobs.exitOnDrift / 100);
  const expires = saved?.expiresAt?.slice(0, 10) ?? new Date(Date.parse(today) + 90 * DAY).toISOString().slice(0, 10);
  const expiresTime = saved?.expiresAt?.slice(11, 16) ?? "00:00";
  return (
    <Form method="post" className="mt-8 space-y-8">
      <input type="hidden" name="asset" value={asset} />
      <input type="hidden" name="status" value={saved?.status ?? "paused"} />

      <div>
        <label htmlFor="allocation" className="flex items-baseline justify-between text-[15px] font-semibold">
          How much may flow
          <span className="tnum condensed text-3xl font-semibold text-river-deep">{allocation}%</span>
        </label>
        <input
          id="allocation" name="allocation" type="range" min={5} max={100} step={5} value={allocation}
          onChange={(e) => setAllocation(+e.target.value)} className="mt-2 w-full accent-[var(--river)]"
        />
        <p className="mt-1 text-[15px] text-ink-2">
          Of the {asset} and USDT in your wallet when a window opens. River deposits them in the ratio you hold, without
          swapping, so any excess of one side stays idle.
        </p>
      </div>

      <fieldset>
        <legend className="text-[15px] font-semibold">Profile</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {PROFILES.map((p) => {
            const on = profile?.id === p.id;
            return (
              <button
                key={p.id} type="button" aria-pressed={on}
                onClick={() => setKnobs({ maxHalfWidth: p.maxHalfWidth * 100, exitOnDrift: p.exitOnDrift * 100 })}
                className={`flex flex-col items-start rounded-control border p-4 text-left transition-colors ${on ? "border-river bg-river-mist" : "border-line bg-solid hover:border-river"}`}
              >
                <span className="block font-semibold">{p.name}</span>
                <span className="mt-1 block text-[14px] text-ink-2">{p.summary}</span>
                <span className="tnum mt-2 block text-[13px] text-ink-3">band up to ±{(p.maxHalfWidth * 100).toFixed(0)}%, leave at {(p.exitOnDrift * 100).toFixed(0)}% drift</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[15px] text-ink-2">
          {profile ? "" : "Custom settings from Advanced. "}
          The band itself comes from IVL and has recently been ±1–2%; the width limit only matters when history is short or unusually wild.
        </p>
      </fieldset>

      <details className="rounded-control border border-line bg-solid/60 p-4" open={!profile}>
        <summary className="cursor-pointer font-semibold">Advanced</summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field label="Widest band (± %)" hint="A limit: River uses the IVL band when it is narrower.">
            <input name="maxHalfWidth" type="number" min={0.5} max={49} step={0.5} value={knobs.maxHalfWidth} onChange={(e) => setKnobs({ ...knobs, maxHalfWidth: +e.target.value })} className={input} />
          </Field>
          <Field label="Leave early at drift (%)" hint="Measured from the entry price.">
            <input name="exitOnDrift" type="number" min={0.5} max={50} step={0.5} value={knobs.exitOnDrift} onChange={(e) => setKnobs({ ...knobs, exitOnDrift: +e.target.value })} className={input} />
          </Field>
          <Field label="Slippage limit (bps)" hint="For adding and removing liquidity. 100 bps = 1%.">
            <input name="slippageBps" type="number" min={1} max={4999} step={1} defaultValue={saved?.slippageBps ?? 100} className={input} />
          </Field>
          <Field label="Mandate valid until (UTC)" hint="River stops entering then, and leaves an open position at that moment.">
            <div className="flex gap-2">
              <input name="expiresAt" type="date" min={today} defaultValue={expires} className={input} required />
              <input name="expiresTime" type="time" defaultValue={expiresTime} className={`${input} max-w-[8.5rem]`} aria-label="Time, UTC" />
            </div>
          </Field>
          <label className="flex items-start gap-3 sm:col-span-2">
            <input name="skipEvents" type="checkbox" defaultChecked={saved?.skipEvents ?? true} className="mt-1 size-4 accent-[var(--river)]" />
            <span>
              <span className="font-semibold">Skip windows with earnings or corporate actions</span>
              <span className="block text-[14px] text-ink-2">Add the dates below, one per line or separated by commas.</span>
            </span>
          </label>
          <Field label="Event dates" hint="YYYY-MM-DD or a full ISO time." wide>
            <textarea name="events" rows={2} defaultValue={(saved?.events ?? []).join("\n")} className={`${input} font-mono text-[14px]`} placeholder="2026-11-18" />
          </Field>
          <label className="flex items-start gap-3 opacity-60 sm:col-span-2">
            <input type="checkbox" disabled className="mt-1 size-4" />
            <span>
              <span className="font-semibold">Restore my share count after each cycle</span>
              <span className="block text-[14px] text-ink-2">Coming soon: a limit order between windows buys or sells back to the shares you started with.</span>
            </span>
          </label>
        </div>
      </details>

      {error && <Notice tone="down">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btn.primary} disabled={nav.state !== "idle"}>{nav.state === "submitting" ? "Saving…" : saved ? "Save changes" : "Save mandate"}</button>
        <Link to="/dashboard" className={btn.quiet}>Cancel</Link>
        <span className="text-[15px] text-ink-2">
          {saved ? (saved.status === "active" ? "Stays active; the agent applies it on its next check." : "Stays paused until you activate it.") : "It starts paused. Preview it from the dashboard, then activate."}
        </span>
      </div>
    </Form>
  );
}

const input = "mt-1 block w-full rounded-control border border-line bg-solid px-3 py-2.5 text-[15px] tabular-nums focus:border-river focus:outline-none";

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[15px] font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[13px] text-ink-3">{hint}</span>}
    </label>
  );
}
