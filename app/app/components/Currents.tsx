// Currents.tsx — the water: lines of liquidity drifting across a whole stage, each carrying glowing particles. It is
// the opening shot of River's film (video/film.html) grown from a square to the full width of the page, and it is
// what marks a "water" stage of the landing: the market is closed and River is at work.
//
// A canvas, not CSS: the curves are sums of sines with seeded phases, the same functions the film draws, so the
// motion is deterministic and cheap. It fills its positioned parent, animates only while on screen and holds a still
// frame for visitors who prefer reduced motion. The server renders an empty canvas; nothing waits for it.

import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;

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

/** `from`/`to`: the vertical band the currents occupy, as fractions of the height. */
export function Currents({ lines = 7, from = 0.3, to = 0.9, className = "", ...rest }: { lines?: number; from?: number; to?: number; className?: string; [data: `data-${string}`]: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const flow = noise(11, 4);
    let w = 0, h = 0, raf = 0, onScreen = true;

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const amp = Math.min(h * 0.045, 22), wl = Math.max(w / 9, 90);
      for (let k = 0; k < lines; k++) {
        const yb = h * (from + ((to - from) * k) / Math.max(1, lines - 1)), ph = k * 1.3;
        const at = (x: number) => yb + Math.sin(x / wl + t * 0.55 + ph) * amp + flow(x / (wl * 2.4) + k) * amp * 0.5;
        ctx.beginPath();
        for (let x = -10; x <= w + 10; x += 6) (x === -10 ? ctx.moveTo : ctx.lineTo).call(ctx, x, at(x));
        ctx.strokeStyle = `rgba(111,155,255,${0.12 + 0.1 * (k % 3)})`;
        ctx.lineWidth = 1 + (k % 3) * 0.55;
        ctx.stroke();
        ctx.fillStyle = "rgba(196,214,255,0.9)";
        ctx.shadowColor = "rgba(111,155,255,0.9)";
        ctx.shadowBlur = 8;
        const gap = 190, n = Math.ceil((w + 80) / gap);
        for (let i = 0; i < n; i++) {
          const x = ((i * gap + k * 57 + t * (34 + k * 7)) % (w + 80)) - 40;
          ctx.beginPath();
          ctx.arc(x, at(x), 1.4 + (k % 2) * 0.8, 0, TAU);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }
    };

    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
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
  }, [lines, from, to]);
  return <canvas ref={ref} aria-hidden className={`pointer-events-none block ${className}`} {...rest} />;
}
