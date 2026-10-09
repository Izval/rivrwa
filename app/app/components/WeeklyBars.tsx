// WeeklyBars.tsx — one column per past closed window: what River would have added, in USD, for the chosen amount.
// Polarity is the job, so the columns grow up or down from a zero baseline, river blue for a gain and red for a
// loss (a pair validated for colour-blind readers), with the sign repeated in the tooltip. Built from plain
// elements so it stays crisp at any width; each column is a focusable target with a tooltip, and a table is
// there for screen readers.

import { useState } from "react";
import { niceTicks } from "../lib/band.ts";
import { dayLabel, usd } from "../lib/format.ts";
import type { SimWindow } from "../lib/simulation.ts";

const GAIN = "var(--river)";
const LOSS = "var(--down)";

export function WeeklyBars({ windows }: { windows: SimWindow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (windows.length === 0) return null;
  const nets = windows.map((w) => w.netUsd);
  const lo = Math.min(0, ...nets), hi = Math.max(0, ...nets);
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi, 4);
  const min = Math.min(lo, ticks[0]), max = Math.max(hi, ticks[ticks.length - 1]);
  const y = (v: number) => ((max - v) / (max - min)) * 100; // % from top
  const zero = y(0);
  const h = hover === null ? null : windows[hover];
  const money = (v: number) => usd(v, Math.abs(v) < 100 ? 2 : 0);
  const tickDp = Math.max(...ticks.map(Math.abs)) < 10 ? 2 : 0;
  return (
    <figure className="m-0">
      <div className="relative h-52 select-none" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 flex h-0 items-center" style={{ top: `${y(t)}%` }}>
            <span className="tnum w-12 pr-2 text-right text-[12px] text-ink-3">{usd(t, tickDp)}</span>
            <span className={`h-px flex-1 ${t === 0 ? "bg-ink-3" : "bg-line"}`} />
          </div>
        ))}
        <div className="absolute inset-y-0 left-12 right-0 flex items-stretch justify-around gap-0.5">
          {windows.map((w, i) => {
            const top = Math.min(y(w.netUsd), zero), height = Math.max(Math.abs(y(w.netUsd) - zero), 0.8);
            const gain = w.netUsd >= 0;
            return (
              <button
                key={w.window} type="button" aria-label={`${dayLabel(w.window)}: ${gain ? "gained" : "lost"} ${usd(Math.abs(w.netUsd))}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                className="group relative h-full max-w-6 flex-1 cursor-default focus-visible:outline-offset-0"
              >
                <span
                  className={`absolute inset-x-0 transition-opacity ${gain ? "rounded-t" : "rounded-b"} ${hover !== null && hover !== i ? "opacity-40" : ""}`}
                  style={{ top: `${top}%`, height: `${height}%`, background: gain ? GAIN : LOSS }}
                />
              </button>
            );
          })}
        </div>
        {h && (
          <div className="glass pointer-events-none absolute left-12 top-0 z-10 rounded-control px-3 py-2 text-[13px] leading-snug">
            <p className="font-semibold text-ink">Weekend of {dayLabel(h.window)}</p>
            <dl className="tnum mt-1 grid grid-cols-[auto_auto] gap-x-4 text-ink-2">
              <dt>LP fees</dt><dd className="text-right">{money(h.feesUsd)}</dd>
              <dt>Impermanent loss</dt><dd className="text-right">{money(-h.ilUsd)}</dd>
              <dt>Gas, River's fee, restore</dt><dd className="text-right">{money(-h.costsUsd)}</dd>
            </dl>
            <p className="tnum font-semibold text-ink">
              <span aria-hidden className="mr-1">{h.netUsd >= 0 ? "▲" : "▼"}</span>
              Net {money(h.netUsd)} ({h.netPct >= 0 ? "+" : ""}{h.netPct.toFixed(2)}%)
            </p>
          </div>
        )}
      </div>
      <div className="ml-12 mt-1 flex justify-between text-[12px] text-ink-3">
        <span>{dayLabel(windows[0].window)}</span>
        <span>{dayLabel(windows[windows.length - 1].window)}</span>
      </div>
      {/* sr-only on a <table> itself does not clip it to 1px; the wrapper does. */}
      <div className="sr-only">
        <table>
          <caption>Net result per past closed window</caption>
          <thead><tr><th>Window</th><th>LP fees</th><th>Impermanent loss</th><th>Costs</th><th>Net</th></tr></thead>
          <tbody>
            {windows.map((w) => (
              <tr key={w.window}><td>{w.window}</td><td>{usd(w.feesUsd)}</td><td>{usd(w.ilUsd)}</td><td>{usd(w.costsUsd)}</td><td>{usd(w.netUsd)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
