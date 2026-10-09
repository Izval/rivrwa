// connect.altana.tsx — flow B setup: an Altana smart account controlled by the user's passkey, and one grant that lets
// River run it for 1, 3 or 6 months. Four steps, three passkey prompts: create the account, fund it, approve the
// position manager once, grant River's session key. The same page signs a returning user in with their passkey,
// and renews a session (?renew=1, signed in) with a single grant.
//
// The wizard keeps its draft (account, passkey reference, River's public session key) in sessionStorage, so a reload
// resumes where it was. None of it is secret: the passkey itself never leaves the device, and River's private
// session key never leaves River's server.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/connect.altana";
import { ASSETS } from "../../../packages/core/src/assets.ts";
import { me, type AltanaView } from "../lib/agent.server.ts";
import { assets as registry } from "../lib/api.server.ts";
import { getOwner } from "../lib/session.server.ts";
import { QrCode } from "../components/QrCode.tsx";
import { Notice, Panel, Pill, btn } from "../components/ui.tsx";
import { SESSION_MONTHS, MIN_BNB_TO_GRANT, FEE_CAP_BNB, defaultCaps, expiryFor, type SessionMonths, type WeeklyCaps } from "../lib/altana.ts";
import { bscscanAddr, bscscanTx, shortAddr, when } from "../lib/format.ts";
import type { PasskeyRef } from "../lib/altana.client.ts";

export const meta: Route.MetaFunction = () => [{ title: "Altana smart account | River" }];

export async function loader({ request }: Route.LoaderArgs) {
  const owner = await getOwner(request);
  const account = owner ? await me(owner).catch(() => null) : null;
  const live = await registry();
  const stocks = (live ?? ASSETS).filter((a) => a.enabled).map((a) => ({ symbol: a.symbol, token: a.token }));
  const renew = new URL(request.url).searchParams.has("renew") && account?.user.kind === "altana" ? account.altana ?? null : null;
  return { owner, kind: account?.user.kind ?? null, renew, stocks, now: Date.now() };
}

type Step = "start" | "fund" | "approve" | "grant" | "done";
interface Draft { account: string; passkey: PasskeyRef; session: { address: string; publicKey: string }; stock: string }

const KEY = "river.altana.draft";
const loadDraft = (): Draft | null => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null"); } catch { return null; } };
const saveDraft = (d: Draft | null) => { try { d ? sessionStorage.setItem(KEY, JSON.stringify(d)) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/connect/altana/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error ?? `River answered ${r.status}`), { status: r.status });
  return j;
}
const lib = () => import("../lib/altana.client.ts");
const msg = (e: unknown) => ((e as Error).name === "NotAllowedError" ? "The passkey prompt was dismissed." : (e as Error).message);

export default function ConnectAltana({ loaderData: d }: Route.ComponentProps) {
  const renew = d.renew;
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <h1 className="condensed text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">
          {renew ? "Renew River's session" : "River on an Altana smart account"}
        </h1>
        <p className="mt-4 max-w-[52ch] text-lg text-ink-2">
          {renew
            ? `Account ${shortAddr(renew.account)}. One passkey tap gives River a new session; the old key is deleted from River's server.`
            : "A smart account that only your passkey controls. You grant River a narrow key once, and it runs every closed window for months, with no app to reopen."}
        </p>
        <ul className="mt-8 space-y-4 text-[15px]">
          <li>
            <strong className="font-semibold">River's key can</strong>
            <span className="text-ink-2"> call the PancakeSwap v3 position manager only: open a position, withdraw it, collect its fees. Nothing else, enforced by the account itself.</span>
          </li>
          <li>
            <strong className="font-semibold">Weekly caps</strong>
            <span className="text-ink-2"> limit how much stock and USDT the key can move per week, plus {FEE_CAP_BNB} BNB for fees. River also checks every call before signing that proceeds go back to this account.</span>
          </li>
          <li>
            <strong className="font-semibold">Where the key lives</strong>
            <span className="text-ink-2"> River's server holds it, encrypted, so it can act while you sleep. Your passkey can revoke it on-chain at any time, and you can withdraw everything with it.</span>
          </li>
        </ul>
        <p className="mt-8 text-[15px] text-ink-3">
          Prefer the Binance App? <Link to="/connect/binance" className={btn.link}>Connect a Binance Agentic Wallet</Link> instead.
        </p>
      </div>
      <Panel className="p-6 sm:p-8">
        {renew ? <Renew view={renew} stocks={d.stocks} /> : <Wizard stocks={d.stocks} signedInAs={d.owner} />}
      </Panel>
    </div>
  );
}

function StepHead({ n, of, title, pill }: { n: number; of: number; title: string; pill?: string }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] text-ink-2">Step {n} of {of}</p>
        {pill && <Pill tone="river" live>{pill}</Pill>}
      </div>
      <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
    </>
  );
}

function Wizard({ stocks, signedInAs }: { stocks: { symbol: string; token: string }[]; signedInAs: string | null }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState<Step>("start");
  const [stock, setStock] = useState(stocks[0]?.token ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const symbol = stocks.find((s) => s.token === (draft?.stock ?? stock))?.symbol ?? "stock";

  useEffect(() => {
    const saved = loadDraft();
    if (saved) { setDraft(saved); setStock(saved.stock); setStep("fund"); }
  }, []);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await f(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const create = () => run("create", async () => {
    const { createAccount } = await lib();
    const { account, passkey } = await createAccount();
    const s = await api<{ sessionAddress: string; sessionPubkey: string }>({ intent: "draft", account, credentialId: passkey.id, passkeyPubkey: passkey.publicKey });
    const d: Draft = { account, passkey, session: { address: s.sessionAddress, publicKey: s.sessionPubkey }, stock };
    saveDraft(d); setDraft(d); setStep("fund");
  });

  const signInWithPasskey = () => run("login", async () => {
    const { assertPasskey } = await lib();
    const c = await api<{ id: string; challenge: string }>({ intent: "challenge" });
    await api({ intent: "login", id: c.id, assertion: await assertPasskey(c.challenge) });
    navigate("/dashboard", { replace: true });
  });

  if (step === "start" || !draft) {
    return (
      <div className="flex h-full flex-col justify-center">
        <StepHead n={1} of={4} title="Create your account" />
        <p className="mt-2 max-w-[46ch] text-ink-2">
          Your device creates a passkey (Face ID, Touch ID or your password manager) and the account's address. Nothing
          is sent on-chain yet.
        </p>
        <label className="mt-6 block text-[15px] font-semibold" htmlFor="stock">Stock River will work with</label>
        <select id="stock" value={stock} onChange={(e) => setStock(e.target.value)} className="mt-2 min-h-11 w-full rounded-control border border-line bg-solid px-3 text-[15px] sm:w-64">
          {stocks.map((s) => <option key={s.token} value={s.token}>{s.symbol}</option>)}
        </select>
        {error && <div className="mt-4"><Notice tone="down">{error}</Notice></div>}
        <div className="mt-6 flex flex-wrap gap-3">
          <button className={btn.primary} onClick={create} disabled={!!busy || !stock}>{busy === "create" ? "Waiting for your passkey…" : "Create with a passkey"}</button>
          <button className={btn.quiet} onClick={signInWithPasskey} disabled={!!busy}>{busy === "login" ? "Checking…" : "I already have one: sign in"}</button>
        </div>
        {signedInAs && <p className="mt-4 text-[13px] text-ink-3">You are signed in as {shortAddr(signedInAs)}; a new account signs you in as the new one.</p>}
      </div>
    );
  }

  if (step === "fund") return <Fund draft={draft} symbol={symbol} onNext={() => setStep("approve")} onRestart={() => { saveDraft(null); setDraft(null); setStep("start"); }} />;

  if (step === "approve") {
    const approve = () => run("approve", async () => {
      const { approvePositionManager } = await lib();
      await approvePositionManager(draft.account, draft.passkey, draft.stock);
      setStep("grant");
    });
    return (
      <div>
        <StepHead n={3} of={4} title="Let the position manager use your tokens" />
        <p className="mt-2 max-w-[46ch] text-ink-2">
          One passkey tap approves PancakeSwap's position manager for {symbol} and USDT. It can only pull tokens when this
          account itself opens a position, which is also the first transaction your account sends.
        </p>
        {error && <div className="mt-4"><Notice tone="down">{error}</Notice></div>}
        <div className="mt-6 flex flex-wrap gap-3">
          <button className={btn.primary} onClick={approve} disabled={!!busy}>{busy ? "Approving…" : "Approve with passkey"}</button>
          <button className={btn.quiet} onClick={() => setStep("grant")} disabled={!!busy}>Already approved</button>
        </div>
      </div>
    );
  }

  return <Grant n={4} of={4} draft={draft} symbol={symbol} onDone={() => { saveDraft(null); navigate("/mandate", { replace: true }); }} />;
}

function Fund({ draft, symbol, onNext, onRestart }: { draft: Draft; symbol: string; onNext: () => void; onRestart: () => void }) {
  const [bal, setBal] = useState<{ bnb: number; stock: number; usd: number } | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const { balances } = await lib(); const b = await balances(draft.account, draft.stock); if (live) setBal(b); } catch { /* retry on the next tick */ }
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => { live = false; clearInterval(id); };
  }, [draft.account, draft.stock]);
  const enoughBnb = (bal?.bnb ?? 0) >= MIN_BNB_TO_GRANT;
  const anyToken = (bal?.stock ?? 0) > 0 || (bal?.usd ?? 0) > 0;
  return (
    <div>
      <StepHead n={2} of={4} title="Fund the account" pill={bal ? undefined : "Reading balances"} />
      <p className="mt-2 max-w-[48ch] text-ink-2">
        Send only what you want River to work with: {symbol} and USDT on BNB Smart Chain, plus at least {MIN_BNB_TO_GRANT} BNB
        for the setup and the relay's fees. The account is yours; you can withdraw at any time with your passkey.
      </p>
      <div className="mt-6 grid gap-6 sm:grid-cols-[160px_1fr] sm:items-center">
        <QrCode value={draft.account} className="hidden size-[160px] rounded-control border border-line sm:block" />
        <div className="min-w-0">
          <p className="text-[15px] text-ink-2">Account address (BSC)</p>
          <p className="mt-1 break-all font-mono text-[15px] text-ink">{draft.account}</p>
          <a href={bscscanAddr(draft.account)} target="_blank" rel="noreferrer" className={`${btn.link} mt-1 inline-block text-[14px]`}>View on BscScan</a>
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-line pt-4 text-[15px]">
        {([["BNB", bal?.bnb, enoughBnb], [symbol, bal?.stock, (bal?.stock ?? 0) > 0], ["USDT", bal?.usd, (bal?.usd ?? 0) > 0]] as const).map(([k, v, ok]) => (
          <div key={k}>
            <dt className="text-[13px] text-ink-3">{k}</dt>
            <dd className={`tnum font-semibold ${ok ? "text-up" : "text-ink"}`}>{v === undefined ? "…" : v.toFixed(k === "USDT" ? 2 : 4)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button className={btn.primary} onClick={onNext} disabled={!enoughBnb || !anyToken}>Continue</button>
        {(!enoughBnb || !anyToken) && <span className="text-[14px] text-ink-3">This updates by itself once the transfer lands.</span>}
      </div>
      <button className={`${btn.link} mt-6 text-[14px]`} onClick={onRestart}>Start over with another passkey</button>
    </div>
  );
}

function Grant({ n, of, draft, symbol, onDone }: { n: number; of: number; draft: Draft; symbol: string; onDone: () => void }) {
  const [months, setMonths] = useState<SessionMonths>(3);
  const [caps, setCaps] = useState<WeeklyCaps | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    lib().then((l) => l.balances(draft.account, draft.stock)).then((b) => setCaps((c) => c ?? defaultCaps(b))).catch(() => setCaps((c) => c ?? { stock: 1, usd: 100 }));
  }, [draft.account, draft.stock]);
  const expiry = useMemo(() => expiryFor(months), [months]);

  const submit = async () => {
    if (!caps) return;
    setBusy("grant"); setError(null);
    try {
      const { grant } = await lib();
      const g = await grant(draft.account, draft.passkey, draft.session, draft.stock, caps, expiry);
      setBusy("confirm");
      // The account contract must list River's key before the agent accepts the grant; public RPCs lag a little.
      for (let i = 0; ; i++) {
        try { await api({ intent: "granted", account: draft.account, serialized: g.serialized, grantTx: g.grantTx }); break; }
        catch (e) { if ((e as { status?: number }).status !== 409 || i >= 8) throw e; await new Promise((r) => setTimeout(r, 4000)); }
      }
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const num = (k: keyof WeeklyCaps, label: string) => (
    <label className="block text-[15px]">
      <span className="text-[13px] text-ink-3">{label} per week</span>
      <input type="number" min={0} step="any" value={caps?.[k] ?? ""} onChange={(e) => setCaps((c) => ({ ...(c ?? { stock: 0, usd: 0 }), [k]: Number(e.target.value) }))}
        className="tnum mt-1 min-h-11 w-full rounded-control border border-line bg-solid px-3" />
    </label>
  );

  return (
    <div>
      <StepHead n={n} of={of} title="Grant River its key" />
      <p className="mt-2 max-w-[48ch] text-ink-2">
        One passkey tap authorises River's key on your account, limited to the position manager and to these weekly caps.
      </p>
      <fieldset className="mt-6">
        <legend className="text-[15px] font-semibold">How long</legend>
        <div className="mt-2 flex gap-2">
          {SESSION_MONTHS.map((m) => (
            <button key={m} type="button" onClick={() => setMonths(m)} aria-pressed={months === m}
              className={`min-h-11 rounded-control border px-4 text-[15px] font-semibold ${months === m ? "border-river bg-river-mist text-river-deep" : "border-line bg-solid text-ink"}`}>
              {m} {m === 1 ? "month" : "months"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[14px] text-ink-3">Ends {when(expiry * 1000)}. River reminds you a week before, on Telegram.</p>
      </fieldset>
      <div className="mt-6 grid grid-cols-2 gap-4">
        {num("stock", symbol)}
        {num("usd", "USDT")}
      </div>
      <p className="mt-2 text-[14px] text-ink-3">Plus {FEE_CAP_BNB} BNB a week for the relay's fees. A deposit above a cap fails safely; raise it with a new grant.</p>
      {error && <div className="mt-4"><Notice tone="down">{error}</Notice></div>}
      <button className={`${btn.primary} mt-6`} onClick={submit} disabled={!!busy || !caps}>
        {busy === "grant" ? "Waiting for your passkey…" : busy === "confirm" ? "Confirming on-chain…" : "Grant with passkey"}
      </button>
    </div>
  );
}

function Renew({ view, stocks }: { view: AltanaView; stocks: { symbol: string; token: string }[] }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stock, setStock] = useState(stocks[0]?.token ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const symbol = stocks.find((s) => s.token === stock)?.symbol ?? "stock";
  const start = async () => {
    setBusy(true); setError(null);
    try {
      const s = await api<{ sessionAddress: string; sessionPubkey: string }>({ intent: "draft", account: view.account, credentialId: view.passkey.id, passkeyPubkey: view.passkey.publicKey });
      setDraft({ account: view.account, passkey: view.passkey, session: { address: s.sessionAddress, publicKey: s.sessionPubkey }, stock });
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  if (draft) return <Grant n={2} of={2} draft={draft} symbol={symbol} onDone={() => navigate("/dashboard", { replace: true })} />;
  return (
    <div className="flex h-full flex-col justify-center">
      <StepHead n={1} of={2} title="A new session" />
      <p className="mt-2 max-w-[46ch] text-ink-2">
        {view.expiresAt ? `The current one ends ${when(view.expiresAt)}.` : "There is no active session."} River keeps using it until the new grant is confirmed.
        {view.grantTx && <> Last grant: <a className={btn.link} href={bscscanTx(view.grantTx)} target="_blank" rel="noreferrer">transaction</a>.</>}
      </p>
      <label className="mt-6 block text-[15px] font-semibold" htmlFor="stock">Stock River will work with</label>
      <select id="stock" value={stock} onChange={(e) => setStock(e.target.value)} className="mt-2 min-h-11 w-full rounded-control border border-line bg-solid px-3 text-[15px] sm:w-64">
        {stocks.map((s) => <option key={s.token} value={s.token}>{s.symbol}</option>)}
      </select>
      <p className="mt-2 text-[14px] text-ink-3">A different stock needs its approval too; the dashboard shows it if a rehearsal fails.</p>
      {error && <div className="mt-4"><Notice tone="down">{error}</Notice></div>}
      <button className={`${btn.primary} mt-6`} onClick={start} disabled={busy}>{busy ? "Preparing…" : `Continue with ${symbol}`}</button>
    </div>
  );
}
