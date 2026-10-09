// connect.tsx — pair a Binance Agentic Wallet. River asks the agent for a pairing code, the person approves it in the
// Binance App, and this page polls until the agent holds the session. Pairing again is also how a pass is renewed:
// Binance caps a sign-in at 7 days, and the Telegram reminder links here.

import { useEffect, useRef, useState } from "react";
import { data, Link, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/connect";
import { startPairing, type PairingStart } from "../lib/agent.server.ts";
import { getOwner, pairCookie } from "../lib/session.server.ts";
import { QrCode } from "../components/QrCode.tsx";
import { Countdown } from "../components/Countdown.tsx";
import { Notice, Panel, Pill, btn } from "../components/ui.tsx";
import { shortAddr } from "../lib/format.ts";
import type { loader as statusLoader } from "./connect.status.ts";

export const meta: Route.MetaFunction = () => [{ title: "Connect your wallet | River" }];

/** Binance's pairing request lives ~6 minutes; the agent gives up at the same time. */
const PAIRING_MS = 6 * 60_000;

export async function loader({ request }: Route.LoaderArgs) {
  return { owner: await getOwner(request), now: Date.now() };
}

export async function action() {
  try {
    const p: PairingStart = await startPairing();
    const expireAt = Number.isFinite(p.expireAt) && p.expireAt > Date.now() ? p.expireAt : Date.now() + PAIRING_MS;
    return data(
      { pairing: { code: p.pairingCode, url: p.urlForWeb, expireAt }, now: Date.now(), error: null },
      { headers: { "set-cookie": await pairCookie().serialize(p.pairingId) } },
    );
  } catch (e) {
    return { pairing: null, now: Date.now(), error: `Binance did not return a pairing code (${(e as Error).message}). Try again.` };
  }
}

export default function Connect({ loaderData }: Route.ComponentProps) {
  const start = useFetcher<typeof action>();
  const res = start.data;
  const pairing = res?.pairing ?? null;
  const renew = !!loaderData.owner;
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <h1 className="condensed text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">
          {renew ? "Renew your Binance pass" : "Connect your Binance Agentic Wallet"}
        </h1>
        <p className="mt-4 max-w-[52ch] text-lg text-ink-2">
          {renew
            ? `You are signed in as ${shortAddr(loaderData.owner!)}. Binance ends a sign-in after 7 days; approving a new pairing gives River another 7.`
            : "River signs from your own Agentic Wallet, inside the limits you set in the Binance App. Your wallet address becomes your River account."}
        </p>
        <ul className="mt-8 space-y-4 text-[15px]">
          <li>
            <strong className="font-semibold">River can</strong>
            <span className="text-ink-2"> open and close PancakeSwap v3 positions for the stocks in your mandate, and claim their fees back to your wallet.</span>
          </li>
          <li>
            <strong className="font-semibold">River will not</strong>
            <span className="text-ink-2"> run anything but those position commands, and Binance holds it to the daily DeFi limit and approval rules you set in the App.</span>
          </li>
          <li>
            <strong className="font-semibold">Where the session lives</strong>
            <span className="text-ink-2"> River's server keeps the Binance session, encrypted, so it can act while you sleep. Disconnect at any time from the dashboard.</span>
          </li>
        </ul>
        <Link to="/connect/altana" className="mt-8 block rounded-control border border-line bg-solid/60 p-4 transition-colors hover:border-river">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Altana smart account</span>
            <Pill tone="river">No Binance App</Pill>
          </div>
          <p className="mt-1 text-[15px] text-ink-2">
            A passkey account funded from any wallet, and one grant that lasts 1 to 6 months. River's key can only call
            the PancakeSwap position manager. <span className={btn.link}>Set it up</span>
          </p>
        </Link>
      </div>

      <Panel className="p-6 sm:p-8">
        {pairing ? (
          <Pairing key={pairing.code} pairing={pairing} now={res!.now} onRetry={() => start.submit(null, { method: "post" })} />
        ) : (
          <div className="flex h-full flex-col justify-center">
            <p className="text-[15px] text-ink-2">Step 1 of 2</p>
            <h2 className="mt-1 text-2xl font-semibold">Get a pairing code</h2>
            <p className="mt-2 max-w-[44ch] text-ink-2">
              You will approve it in the Binance App, on this phone or by scanning a QR code from another screen.
            </p>
            {res?.error && <div className="mt-4"><Notice tone="down">{res.error}</Notice></div>}
            <start.Form method="post" className="mt-6">
              <button className={btn.primary} disabled={start.state !== "idle"}>
                {start.state !== "idle" ? "Asking Binance for a code…" : "Get pairing code"}
              </button>
            </start.Form>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Pairing({ pairing, now, onRetry }: { pairing: { code: string; url: string; expireAt: number }; now: number; onRetry: () => void }) {
  const poll = useFetcher<typeof statusLoader>();
  const navigate = useNavigate();
  const [expired, setExpired] = useState(false);
  const state = poll.data?.state ?? "pending";

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (state !== "pending" || expired) return;
    const id = setInterval(() => {
      if (Date.now() > pairing.expireAt) return setExpired(true);
      if (pollRef.current.state === "idle") pollRef.current.load("/connect/binance/status");
    }, 2000);
    return () => clearInterval(id);
  }, [state, expired, pairing.expireAt]);

  useEffect(() => {
    if (state === "success") navigate("/dashboard", { replace: true });
  }, [state, navigate]);

  if (state === "failed" || state === "none" || expired) {
    return (
      <div>
        <h2 className="text-2xl font-semibold">{expired ? "The pairing code expired" : "Pairing did not complete"}</h2>
        <p className="mt-2 text-ink-2">
          {poll.data?.state === "failed" && poll.data.error ? poll.data.error : "Codes last about six minutes. Ask for a new one and approve it in the Binance App."}
        </p>
        <button className={`${btn.primary} mt-6`} onClick={onRetry}>Get a new code</button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] text-ink-2">Step 2 of 2</p>
        <Pill tone={state === "success" ? "up" : "river"} live={state !== "success"}>
          {state === "success" ? "Paired" : "Waiting for approval"}
        </Pill>
      </div>
      <h2 className="mt-1 text-2xl font-semibold">Approve River in the Binance App</h2>
      <div className="mt-6 grid gap-6 sm:grid-cols-[180px_1fr] sm:items-center">
        <QrCode value={pairing.url} className="hidden size-[180px] rounded-control border border-line sm:block" />
        <div>
          <p className="text-[15px] text-ink-2">Pairing code</p>
          <p className="mt-1 break-all font-mono text-[28px] font-medium tracking-[0.08em] text-ink">{pairing.code}</p>
          <p className="mt-2 text-[15px] text-ink-3">
            Check that the app shows this same code. Expires in <Countdown to={pairing.expireAt} serverNow={now} />.
          </p>
        </div>
      </div>
      <a href={pairing.url} className={`${btn.primary} mt-6 w-full sm:w-auto`} target="_blank" rel="noreferrer">Open in Binance App</a>
      <p className="mt-4 text-[15px] text-ink-3">
        On a computer, scan the code with your phone's camera. This page moves on by itself once you approve.
      </p>
    </div>
  );
}
