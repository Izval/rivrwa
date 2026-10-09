// AppShell.tsx — the sticky top bar and the page frame. Signed-in people get the three places they manage River
// from; everyone else gets the one action that starts it.

import type { ReactNode } from "react";
import { Form, Link, NavLink } from "react-router";
import { Logo } from "./Logo.tsx";
import { btn } from "./ui.tsx";
import { shortAddr } from "../lib/format.ts";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/mandate", label: "Mandate" },
  { to: "/history", label: "History" },
];

export function AppShell({ owner, children }: { owner: string | null; children: ReactNode }) {
  return (
    <>
      <header className="glass-bar sticky top-0 z-20">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-6 px-4 sm:px-8">
          <Link to="/" aria-label="River home"><Logo /></Link>
          {owner && (
            <nav className="hidden gap-1 sm:flex" aria-label="Main">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-control px-3 py-2 text-[15px] font-semibold transition-colors ${isActive ? "bg-river-mist text-river-deep" : "text-ink-2 hover:text-ink"}`}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            <NavLink to="/agent" className={({ isActive }) => `hidden rounded-control px-3 py-2 text-[15px] font-semibold sm:block ${isActive ? "bg-river-mist text-river-deep" : "text-ink-2 hover:text-ink"}`}>For agents</NavLink>
            {owner ? (
              <details className="group relative">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-solid px-3.5 font-mono text-[13px] text-ink-2 hover:border-river">
                  <span aria-hidden className="size-2 rounded-full bg-up" />
                  {shortAddr(owner)}
                </summary>
                <div className="glass absolute right-0 mt-2 w-64 rounded-control p-2">
                  <p className="px-2 pb-2 pt-1 text-[13px] text-ink-3">Signed in as your River wallet</p>
                  <p className="break-all px-2 pb-2 font-mono text-[12px] text-ink-2">{owner}</p>
                  <Form method="post" action="/logout">
                    <button className="w-full rounded-lg px-2 py-2 text-left text-[15px] font-semibold hover:bg-river-mist">Sign out of River</button>
                  </Form>
                </div>
              </details>
            ) : (
              <Link to="/connect/binance" className={btn.primary}>Connect wallet</Link>
            )}
          </div>
        </div>
        {owner && (
          <nav className="flex gap-1 overflow-x-auto px-4 pb-2 sm:hidden" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-control px-3 py-1.5 text-[15px] font-semibold ${isActive ? "bg-river-mist text-river-deep" : "text-ink-2"}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-[1120px] px-4 pb-24 pt-8 sm:px-8 sm:pt-12">{children}</main>
      <footer className="mx-auto max-w-[1120px] border-t border-line px-4 py-8 text-[13px] text-ink-3 sm:px-8">
        River is non-custodial: it has no vault and no contracts of its own. Your shares stay in your wallet and only
        move into a PancakeSwap v3 position you own. <Link to="/agent" className="font-semibold text-river">River for agents</Link>: ERC-8004
        identity, x402 and MCP.
      </footer>
    </>
  );
}
