// BandSchematic.tsx — how River places a position, drawn as an engineering schematic: the pool's liquidity as hairline
// bars over a price ruler, River's band (IVL μ ± 2σ) filled like water, the weekend's price tracing down inside it,
// and leader lines out to mono labels. It is the "land" counterpart of the water stages: precise, measured, still.
//
// The first time it scrolls into view anime.js draws every line in (createDrawable), the band fills like water, and
// the labels come up one by one; it then stays drawn. Labels are SVG text, which would be too small on a phone; there they are hidden and a
// numbered legend under the drawing says the same. Reduced motion shows the finished drawing.

import { useEffect, useRef } from "react";
import { createDrawable, createScope, createTimeline, onScroll, stagger, utils } from "animejs";

const BASE = 440, LO = 380, HI = 620, MU = 500;
// Rounded: the server (workerd) and the browser can differ in the last digit of Math.exp/sin, and SVG attributes
// that differ by 1e-14 are a hydration mismatch.
const r1 = (x: number) => Math.round(x * 10) / 10;
const barH = (x: number) => r1(26 + 236 * Math.exp(-(((x - MU) / 175) ** 2)) + 14 * Math.sin(x * 0.11) * Math.sin(x * 0.037));
const BARS = Array.from({ length: 50 }, (_, i) => r1(100 + i * 16.3));
const PRICE = Array.from({ length: 41 }, (_, i) => {
  const y = 112 + i * 8;
  return `${(MU + 58 * Math.sin(i * 0.55) + 26 * Math.sin(i * 1.7 + 1)).toFixed(1)},${y}`;
}).join(" ");

/** Leader lines: the points from the feature out to the label, the label, and which side it reads from. */
const LEADERS: { pts: string; text: string; at: [number, number]; end?: boolean }[] = [
  { pts: `${MU},104 ${MU},44 640,44`, text: "price at entry · μ", at: [650, 48] },
  { pts: `${LO},150 330,92 40,92`, text: "μ − 2σ", at: [40, 84] },
  { pts: `${HI},150 670,92 960,92`, text: "μ + 2σ", at: [960, 84], end: true },
  { pts: `150,${r1(BASE - barH(150))} 130,338 40,338`, text: "other LPs' liquidity", at: [40, 330] },
  { pts: `${LO + 30},380 370,246 40,246`, text: "your band · IVL, last 4 weekends", at: [40, 238] },
  { pts: `${MU + 40},236 700,190 960,190`, text: "every swap through it pays you", at: [960, 182], end: true },
  { pts: `${MU + 30},372 720,288 960,288`, text: "the weekend's price, hour by hour", at: [960, 280], end: true },
];

export function BandSchematic() {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scope = createScope().add(() => {
      if (svg.getBoundingClientRect().top < window.innerHeight) return; // already on screen: leave it drawn
      const lines = createDrawable(svg.querySelectorAll("[data-draw]"));
      const fills = svg.querySelectorAll("[data-fill]"), labels = svg.querySelectorAll("[data-label]");
      utils.set(lines, { draw: "0 0" });
      utils.set([...fills, ...labels], { opacity: 0 });
      const tl = createTimeline({ autoplay: false })
        .add(lines, { draw: "0 1", duration: 900, delay: stagger(10), ease: "inOut(2)" }, 0)
        .add(fills, { opacity: 1, duration: 900 }, 500)
        .add(labels, { opacity: 1, duration: 400, delay: stagger(70) }, 900);
      onScroll({ target: svg, enter: "bottom-=80 top", repeat: false, onEnter: () => tl.play() });
    });
    return () => scope.revert();
  }, []);

  return (
    <figure className="m-0">
      <svg ref={ref} viewBox="0 0 1000 490" className="w-full" role="img" aria-label="River's band: IVL μ ± 2σ around the entry price, over the pool's liquidity, with the weekend's price inside it.">
        <defs>
          <linearGradient id="band-water" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--river)" stopOpacity="0.02" />
            <stop offset="1" stopColor="var(--river)" stopOpacity="0.16" />
          </linearGradient>
        </defs>
        <rect data-fill x={LO} y="120" width={HI - LO} height={BASE - 120} fill="url(#band-water)" />
        {/* the price ruler */}
        <line data-draw x1="40" x2="960" y1={BASE + 10} y2={BASE + 10} stroke="var(--ink-3)" strokeWidth="1" />
        {Array.from({ length: 93 }, (_, i) => 40 + i * 10).map((x, i) => (
          <line key={x} data-draw x1={x} x2={x} y1={BASE + 10} y2={BASE + 10 + (i % 5 === 0 ? 12 : 6)} stroke="var(--ink-3)" strokeWidth="1" />
        ))}
        <text data-label x="960" y={BASE + 42} textAnchor="end" className="max-md:hidden" fill="var(--ink-3)" fontFamily="var(--font-mono)" fontSize="13">price · USD</text>
        {/* the pool's liquidity; River's share is the band */}
        {BARS.map((x) => {
          const inBand = x >= LO && x + 10 <= HI;
          return <rect key={x} data-draw x={x} y={r1(BASE - barH(x))} width="10" height={barH(x)} fill="none" stroke={inBand ? "var(--river)" : "var(--ink-3)"} strokeWidth={inBand ? 1.4 : 1} strokeOpacity={inBand ? 1 : 0.7} />;
        })}
        <line data-draw x1={LO} x2={LO} y1="120" y2={BASE} stroke="var(--river)" strokeWidth="1.5" strokeDasharray="5 5" />
        <line data-draw x1={HI} x2={HI} y1="120" y2={BASE} stroke="var(--river)" strokeWidth="1.5" strokeDasharray="5 5" />
        <line data-draw x1={MU} x2={MU} y1="104" y2={BASE} stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="2 4" />
        <polyline data-draw points={PRICE} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
        {LEADERS.map((l, i) => {
          const [cx, cy] = l.pts.split(" ")[0].split(",").map(Number);
          return (
            <g key={`m${i}`} className="md:hidden">
              <circle cx={cx} cy={cy} r="17" fill="var(--ink)" />
              <text x={cx} y={cy + 7} textAnchor="middle" fill="#fff" fontFamily="var(--font-mono)" fontSize="20" fontWeight="600">{i + 1}</text>
            </g>
          );
        })}
        {LEADERS.map((l, i) => (
          <g key={l.text} className="max-md:hidden">
            <polyline data-draw points={l.pts} fill="none" stroke="var(--ink-3)" strokeWidth="1" />
            <circle data-label cx={l.pts.split(" ")[0].split(",")[0]} cy={l.pts.split(" ")[0].split(",")[1]} r="3.5" fill="var(--ink)" />
            <text data-label x={l.at[0]} y={l.at[1]} textAnchor={l.end ? "end" : "start"} fill="var(--ink)" fontFamily="var(--font-mono)" fontSize="14">
              <tspan fill="var(--river)">{String(i + 1).padStart(2, "0")} </tspan>{l.text}
            </text>
          </g>
        ))}
      </svg>
      <ol className="mt-4 grid gap-x-6 gap-y-1 font-mono text-[12px] text-ink-2 sm:grid-cols-2 md:hidden">
        {LEADERS.map((l, i) => <li key={l.text}><span className="font-semibold text-river">{i + 1}</span> {l.text}</li>)}
      </ol>
    </figure>
  );
}
