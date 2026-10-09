// AppShell.tsx — the sticky top bar and the page frame. Signed-in people get the three places they manage River
// from; everyone else gets the one action that starts it.
//
// On the landing the bar floats clear over the water of the hero (white text, no fill) and turns solid white as soon
// as the page scrolls; everywhere else it is solid from the start. The footer ends with the Zevlat Intelligence layer:
// River is one of its ventures, next to IVL, the range metric River's band is measured with.

import { useEffect, useState, type ReactNode } from "react";
import { Form, Link, NavLink, useLocation } from "react-router";
import { Logo } from "./Logo.tsx";
import { btn } from "./ui.tsx";
import { shortAddr } from "../lib/format.ts";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/mandate", label: "Mandate" },
  { to: "/history", label: "History" },
];

/** Over the landing's hero until the page scrolls. */
function useClearBar() {
  const overlay = useLocation().pathname === "/";
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!overlay) return;
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [overlay]);
  return { overlay, clear: overlay && !scrolled };
}

export function AppShell({ owner, children }: { owner: string | null; children: ReactNode }) {
  const { overlay, clear } = useClearBar();
  const link = (active: boolean) => active ? (clear ? "bg-white/10 text-white" : "bg-river-mist text-river-deep") : clear ? "text-white/80 hover:text-white" : "text-ink-2 hover:text-ink";
  return (
    <>
      {/* -mb-16 on the landing lets the hero run under the bar, so the bar can sit on the water. */}
      <header className={`sticky top-0 z-20 border-b transition-[background-color,border-color,color,box-shadow] duration-300 ${overlay ? "-mb-16" : ""} ${clear ? "border-transparent bg-transparent text-white" : "border-line bg-white text-ink shadow-[0_1px_12px_rgb(14_23_38/0.06)]"}`}>
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-6 px-4 sm:px-8">
          <Link to="/" aria-label="River home"><Logo /></Link>
          {owner && (
            <nav className="hidden gap-1 sm:flex" aria-label="Main">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-control px-3 py-2 text-[15px] font-semibold transition-colors ${link(isActive)}`}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            <NavLink to="/agent" className={({ isActive }) => `hidden rounded-control px-3 py-2 text-[15px] font-semibold transition-colors sm:block ${link(isActive)}`}>For agents</NavLink>
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
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-control px-3 py-1.5 text-[15px] font-semibold ${link(isActive)}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-[1120px] px-4 pb-24 pt-8 sm:px-8 sm:pt-12">{children}</main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-[1120px] px-4 py-8 text-[13px] text-ink-3 sm:px-8">
          River is non-custodial: it has no vault and no contracts of its own. Your shares stay in your wallet and only
          move into a PancakeSwap v3 position you own. <Link to="/agent" className="font-semibold text-river">River for agents</Link>: ERC-8004
          identity, x402 and MCP.
        </p>
        <div className="bg-ink text-white">
          <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-6 sm:px-8">
            <a href="https://zvlint.com" target="_blank" rel="noreferrer" className="group flex items-baseline gap-3">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">A venture of</span>
              <span className="text-[17px] font-semibold tracking-[-0.01em] transition-colors group-hover:text-[#8fb0ff]">Zevlat Intelligence</span>
            </a>
            <nav aria-label="Zevlat Intelligence" className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] font-semibold text-white/60">
              <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer" className="hover:text-white">IVL research</a>
              <a href="https://github.com/Izval/rivrwa" target="_blank" rel="noreferrer" className="hover:text-white">Source on GitHub</a>
              <Link to="/agent" className="hover:text-white">River for agents</Link>
            </nav>
          </div>
        </div>
      </footer>
    </>
  );
}
