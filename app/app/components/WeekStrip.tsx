// WeekStrip.tsx — River's signature: the calendar around one NYSE closed window as dry land and water. The water is
// when your shares can work; the two white marks are when River enters and leaves; the ink line is now.

import type { ClosedWindow } from "../../../packages/core/src/clock.ts";
import { weekStrip } from "../lib/week.ts";
import { when } from "../lib/format.ts";
import { useNow } from "./Countdown.tsx";

const at = (x: number) => ({ left: `${(x * 100).toFixed(3)}%` });

export function WeekStrip({ window: w, serverNow, compact = false }: { window: ClosedWindow; serverNow: number; compact?: boolean }) {
  const now = useNow(60_000, serverNow);
  const s = weekStrip(w, now);
  const reason = w.reason === "weekend" ? "weekend" : w.reason === "holiday" ? "holiday" : "long weekend";
  return (
    <figure className="m-0" aria-label={`NYSE closed window from ${when(w.start)} to ${when(w.end)}`}>
      <div className="relative h-6 text-[13px] text-ink-3">
        {s.days.map((d) => (
          <span key={d.x} className="absolute -translate-x-1/2 tabular-nums" style={at(d.x)}>{d.label}</span>
        ))}
      </div>
      <div className={`relative ${compact ? "h-9" : "h-14 sm:h-16"} overflow-hidden rounded-[14px] bg-[var(--dry)]`}>
        {/* hour grain on dry land */}
        <div aria-hidden className="absolute inset-0 opacity-60 [background:repeating-linear-gradient(90deg,transparent_0_11px,rgb(14_23_38/0.06)_11px_12px)]" />
        {s.days.map((d) => <span key={d.x} aria-hidden className="absolute inset-y-0 w-px bg-[rgb(14_23_38/0.14)]" style={at(d.x)} />)}
        <div className="river-flow absolute inset-y-0" style={{ left: `${s.windowStart * 100}%`, width: `${(s.windowEnd - s.windowStart) * 100}%` }} />
        {[s.entry, s.exit].map((x) => <span key={x} aria-hidden className="absolute inset-y-2 w-[3px] -translate-x-1/2 rounded-full bg-white/90" style={at(x)} />)}
        {s.now !== null && (
          <span aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={at(s.now)}>
            <span className="absolute left-1/2 top-1 size-2 -translate-x-1/2 rounded-full bg-ink ring-2 ring-white" />
          </span>
        )}
        {!compact && (
          <span className="absolute top-1/2 hidden -translate-y-1/2 pl-3 text-[13px] font-semibold text-white/95 sm:block" style={at(s.entry)}>
            Closed {w.hours}h for the {reason}
          </span>
        )}
      </div>
      <div className="relative mt-1.5 h-10 text-[13px] leading-tight">
        <span className="absolute -translate-x-1/2 text-center" style={at(s.entry)}>
          <span className="block font-semibold text-ink">River enters</span>
          <span className="tnum block whitespace-nowrap text-ink-3">{when(w.start + 3_600_000).replace(" UTC", "")}</span>
        </span>
        <span className="absolute -translate-x-1/2 text-center" style={at(s.exit)}>
          <span className="block font-semibold text-ink">Leaves</span>
          <span className="tnum block whitespace-nowrap text-ink-3">{when(w.end - 7_200_000).replace(" UTC", "")}</span>
        </span>
      </div>
    </figure>
  );
}
