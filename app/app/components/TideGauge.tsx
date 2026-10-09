// TideGauge.tsx — water and time in one instrument, for the hero. A ruler of hours runs across the days around the next
// NYSE closed window; inside the window the water rises and moves, because that is when your shares work. White marks
// show when River enters and leaves, a cursor shows now, and the countdown to River's next move ticks in seconds.
//
// The ruler and the water share one coordinate system in hours (an SVG stretched to the width), while every label is
// HTML placed by percentage, so text never stretches. The water's surface is redrawn each frame from a few sines; on
// first load (html.intro, see app.css) the hour marks sweep in and the water fills the window with anime.js.

import { useEffect, useRef } from "react";
import { animate, stagger, utils } from "animejs";
import type { ClosedWindow } from "../../../packages/core/src/clock.ts";
import { useNow } from "./Countdown.tsx";

const H = 3_600_000, DAY = 24 * H;
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  return `${d ? `${d}d ` : ""}${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** The water's surface across [x0, x1] (hours), filled to `level` of the 100-unit height and moving with `t`. */
function surface(x0: number, x1: number, level: number, t: number, phase: number, rise: number) {
  const pts: string[] = [];
  for (let x = x0; x <= x1 + 0.01; x += 0.5) {
    const y = 100 - level * rise + (Math.sin(x * 0.42 + t * 1.3 + phase) * 2.6 + Math.sin(x * 0.17 - t * 0.7 + phase) * 1.8) * level;
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return pts.join(" L");
}
const body = (x0: number, x1: number, line: string) => `M${x0} 100 L${line} L${x1} 100 Z`;

export function TideGauge({ window: w, entry, exit, serverNow }: { window: ClosedWindow; entry: number; exit: number; serverNow: number }) {
  const now = useNow(1000, serverNow);
  const from = w.start - 30 * H, to = w.end + 18 * H, span = (to - from) / H;
  const hx = (t: number) => (t - from) / H; // hours from the left edge
  const pct = (t: number) => `${((hx(t) / span) * 100).toFixed(3)}%`;
  const [x0, x1] = [hx(w.start), hx(w.end)];
  const closed = now >= w.start && now < w.end;
  const [label, target] = now < entry ? ["River enters the pool in", entry] : now < exit ? ["River leaves the pool in", exit] : ["The market reopens in", w.end];
  const kind = w.reason === "holiday" ? "holiday" : w.reason === "weekend+holiday" ? "long weekend" : "weekend";

  const hours: number[] = [];
  for (let t = Math.ceil(from / H) * H; t <= to; t += H) hours.push(t);
  const days = hours.filter((t) => t % DAY === 0 && t + 12 * H < to).map((t) => t + 12 * H);

  const back = useRef<SVGPathElement>(null), front = useRef<SVGPathElement>(null), crest = useRef<SVGPathElement>(null);
  const ticks = useRef<SVGGElement>(null), water = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const level = { v: 1 };
    const paint = (t: number) => {
      back.current?.setAttribute("d", body(x0, x1, surface(x0, x1, level.v, t, 1.7, 66)));
      const line = surface(x0, x1, level.v, t, 0, 56);
      front.current?.setAttribute("d", body(x0, x1, line));
      crest.current?.setAttribute("d", `M${line}`);
    };
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anims: { revert(): unknown }[] = [];
    if (document.documentElement.classList.contains("intro")) {
      level.v = 0;
      const lines = ticks.current?.querySelectorAll("line") ?? [];
      utils.set(lines, { opacity: 0 });
      utils.set([ticks.current!, water.current!], { opacity: 1 });
      anims.push(animate(lines, { opacity: 1, duration: 500, delay: stagger(9, { start: 250 }), ease: "out(2)" }));
      anims.push(animate(level, { v: 1, duration: 2000, delay: 700, ease: "out(3)" }));
    }
    paint(4);
    if (still) return;
    let raf = 0;
    const loop = () => { paint(performance.now() / 1000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); anims.forEach((a) => a.revert()); };
  }, [x0, x1]);

  return (
    <figure className="m-0" aria-label={`NYSE closed for the ${kind} from ${day(w.start)} ${hhmm(w.start)} to ${day(w.end)} ${hhmm(w.end)} UTC. ${label} ${clock(target - now)}.`}>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div>
          <p className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-[#8fb0ff]">
            <span aria-hidden className={`size-2 rounded-full ${closed ? "live-dot bg-[#6f9bff]" : "bg-white/40"}`} />
            {closed ? "NYSE closed · River's window" : "NYSE open · next window"}
          </p>
          <p className="mt-2 text-[15px] text-white/65">
            Closed {w.hours} h for the {kind}: {day(w.start)} {hhmm(w.start)} → {day(w.end)} {hhmm(w.end)} UTC
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-[15px] text-white/65">{label}</p>
          <time dateTime={new Date(target).toISOString()} suppressHydrationWarning className="tnum mt-1 block font-mono text-[40px] font-medium leading-none tracking-[-0.03em] text-white sm:text-[56px]">
            {clock(target - now)}
          </time>
        </div>
      </div>

      <div className="relative mt-8 h-5 font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
        {days.map((t) => <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pct(t) }}>{day(t)}</span>)}
      </div>
      <div className="relative h-24 sm:h-32">
        <div className="absolute inset-0 overflow-hidden rounded-[14px] border border-white/10 bg-white/[0.03]">
          <svg ref={water} data-intro viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              <linearGradient id="tide" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#6f9bff" stopOpacity="0.95" />
                <stop offset="1" stopColor="#1f5bff" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            <path ref={back} fill="#3d74ff" fillOpacity="0.28" />
            <path ref={front} fill="url(#tide)" />
            <path ref={crest} fill="none" stroke="#dbe6ff" strokeOpacity="0.8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
          <svg viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
            <g ref={ticks} data-intro>
              {hours.map((t) => {
                const midnight = t % DAY === 0, six = t % (6 * H) === 0;
                return (
                  <line key={t} x1={hx(t)} x2={hx(t)} y1="0" y2={midnight ? 100 : six ? 24 : 11} vectorEffect="non-scaling-stroke"
                    stroke="#fff" strokeOpacity={midnight ? 0.18 : six ? 0.45 : 0.22} strokeWidth={six ? 1.5 : 1} />
                );
              })}
            </g>
          </svg>
        </div>
        {[entry, exit].map((t) => (
          <span key={t} aria-hidden className="absolute inset-y-1.5 w-[3px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_12px_rgb(111_155_255/0.9)]" style={{ left: pct(t) }} />
        ))}
        {now >= from && now <= to && (
          <span aria-hidden className="absolute -inset-y-1 w-px -translate-x-1/2 bg-[#ffcf6e]" style={{ left: pct(now) }}>
            <span className="absolute -top-1 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-[#ffcf6e] shadow-[0_0_10px_#ffcf6e]" />
            <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#ffcf6e]">now</span>
          </span>
        )}
      </div>
      <div className="relative mt-7 h-10 text-[13px] leading-tight">
        {([[entry, "River enters"], [exit, "River leaves"]] as const).map(([t, what]) => (
          <span key={t} className="absolute -translate-x-1/2 text-center" style={{ left: pct(t) }}>
            <span className="block font-semibold text-white">{what}</span>
            <span className="tnum block whitespace-nowrap font-mono text-[12px] text-white/50">{day(t)} {hhmm(t)}</span>
          </span>
        ))}
      </div>
    </figure>
  );
}
