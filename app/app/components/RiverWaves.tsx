// RiverWaves.tsx — the landing's stage: five currents of liquidity drifting left to right, each carrying a few
// particles, over a dot grid with registration corners. It is the opening shot of River's film (video/film.html,
// first cut) brought to the page, so the site and the film share one picture.
//
// A canvas, not CSS: the curves are sums of sines with seeded phases, the same functions the film draws, so the
// motion is deterministic and cheap. It only animates while on screen, and draws a single still frame when the
// visitor prefers reduced motion. The server renders an empty canvas; nothing on the page waits for it.

import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;
const RIVER = "31,91,255", MIST = "232,238,255", INK3 = "138,147,163";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Smooth deterministic noise: a sum of sines with seeded frequencies and phases. */
function noise(seed: number, n = 5) {
  const r = rng(seed);
  const w = Array.from({ length: n }, (_, i) => ({ f: 0.6 + i * 1.7 + r() * 0.8, p: r() * TAU, a: 1 / (i + 1) }));
  return (x: number) => w.reduce((s, k) => s + k.a * Math.sin(x * k.f + k.p), 0) / 1.6;
}

export function RiverWaves({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const flow = noise(11, 4);
    let side = 0, raf = 0, onScreen = true;
    // Stage units 0–100 inside a 4% margin, so the corner marks and the glow have room.
    const pad = () => side * 0.04, U = () => (side - 2 * pad()) / 100;
    const X = (x: number) => pad() + x * U(), Y = X;

    const draw = (t: number) => {
      const u = U();
      ctx.clearRect(0, 0, side, side);
      const g = ctx.createRadialGradient(X(52), Y(48), u * 4, X(52), Y(48), u * 52);
      g.addColorStop(0, `rgba(${MIST},0.95)`);
      g.addColorStop(1, `rgba(${MIST},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, side, side);
      ctx.fillStyle = `rgba(${INK3},0.28)`;
      for (let x = 0; x <= 100; x += 5) for (let y = 0; y <= 100; y += 5) ctx.fillRect(X(x) - 1, Y(y) - 1, 2, 2);
      ctx.strokeStyle = `rgba(${INK3},0.55)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [x, y, dx, dy] of [[-2, -2, 1, 1], [102, -2, -1, 1], [-2, 102, 1, -1], [102, 102, -1, -1]]) {
        ctx.moveTo(X(x), Y(y + dy * 3));
        ctx.lineTo(X(x), Y(y));
        ctx.lineTo(X(x + dx * 3), Y(y));
      }
      ctx.stroke();
      for (let k = 0; k < 5; k++) {
        const yb = 30 + k * 10, ph = k * 1.3;
        const at = (x: number) => yb + Math.sin(x / 9 + t * 0.9 + ph) * 3.2 + flow(x / 20 + k) * 1.4;
        ctx.beginPath();
        for (let x = -2; x <= 102; x += 1) (x === -2 ? ctx.moveTo : ctx.lineTo).call(ctx, X(x), Y(at(x)));
        ctx.strokeStyle = `rgba(${RIVER},${0.16 + 0.14 * (k % 2)})`;
        ctx.lineWidth = Math.max(1, (0.5 + 0.25 * (k % 3)) * u);
        ctx.stroke();
        ctx.fillStyle = `rgba(${RIVER},0.8)`;
        for (let i = 0; i < 9; i++) { // particles carried by the current
          const x = ((i * 12.3 + t * (7 + k * 1.5)) % 112) - 6;
          if (x < -2 || x > 102) continue;
          ctx.beginPath();
          ctx.arc(X(x), Y(at(x)), 0.45 * u, 0, TAU);
          ctx.fill();
        }
      }
    };

    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      side = cv.clientWidth;
      cv.width = Math.round(side * dpr);
      cv.height = Math.round(side * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(still ? 4 : performance.now() / 1000);
    };
    const loop = () => {
      if (onScreen) draw(performance.now() / 1000);
      raf = requestAnimationFrame(loop);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; });
    io.observe(cv);
    if (!still) raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);
  return <canvas ref={ref} aria-hidden className={`block aspect-square w-full ${className}`} />;
}
