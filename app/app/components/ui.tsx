// ui.tsx — River's small component kit. Large surfaces are frosted glass with a 20px radius; controls are 12px; pills
// are round. Blue marks the primary action and the river itself; green/red only ever describe data.

import type { ReactNode } from "react";

export const btn = {
  primary:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-river px-5 text-[15px] font-semibold text-white " +
    "shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_6px_16px_-6px_rgb(31_91_255/0.6)] transition-colors hover:bg-river-deep " +
    "disabled:cursor-not-allowed disabled:bg-ink-3 disabled:shadow-none",
  quiet:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-line bg-solid px-5 text-[15px] font-semibold " +
    "text-ink transition-colors hover:border-river hover:text-river disabled:cursor-not-allowed disabled:opacity-50",
  link: "font-semibold text-river underline-offset-4 hover:underline",
};

export function Panel({ className = "", children, as: As = "section" }: { className?: string; children: ReactNode; as?: "section" | "div" | "article" }) {
  return <As className={`glass rounded-panel ${className}`}>{children}</As>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-ink-3">{label}</div>
      <div className={`tnum condensed mt-0.5 text-2xl font-semibold leading-tight ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink"}`}>
        {tone === "up" && <span aria-hidden className="mr-1 text-base">▲</span>}
        {tone === "down" && <span aria-hidden className="mr-1 text-base">▼</span>}
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[13px] text-ink-3">{hint}</div>}
    </div>
  );
}

type PillTone = "river" | "up" | "down" | "warn" | "muted";
const PILL: Record<PillTone, string> = {
  river: "bg-river-mist text-river-deep",
  up: "bg-[rgb(14_159_110/0.1)] text-up",
  down: "bg-[rgb(214_69_93/0.1)] text-down",
  warn: "bg-[rgb(183_121_31/0.12)] text-warn",
  muted: "bg-[rgb(14_23_38/0.05)] text-ink-2",
};

export function Pill({ tone = "muted", live, children }: { tone?: PillTone; live?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${PILL[tone]}`}>
      {live && <span aria-hidden className="live-dot size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-panel border border-dashed border-line px-6 py-10 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-ink-2">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "warn" | "down"; children: ReactNode }) {
  const c = tone === "warn" ? "border-[rgb(183_121_31/0.35)] bg-[rgb(183_121_31/0.07)]" : tone === "down" ? "border-[rgb(214_69_93/0.35)] bg-[rgb(214_69_93/0.06)]" : "border-line bg-solid/60";
  return <div className={`rounded-control border px-4 py-3 text-[15px] text-ink-2 ${c}`}>{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`shimmer rounded-control ${className}`} />;
}
