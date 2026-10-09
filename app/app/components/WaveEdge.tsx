// WaveEdge.tsx — the water's surface between two stages of the landing. The band is painted in the colour above and
// the waves in the colour below, so the page reads as land meeting water (or the reverse) instead of a flat cut. Two
// layers drift at different speeds and directions; under reduced motion they hold still (app.css).

const WAVE = (() => {
  // Four periods across 2400 units: the second half repeats the first, so translating by -50% loops seamlessly.
  let d = "M0 30";
  for (let x = 0; x < 2400; x += 600) d += ` C${x + 150} 12 ${x + 150} 12 ${x + 300} 30 S${x + 450} 48 ${x + 600} 30`;
  return d + " L2400 64 L0 64 Z";
})();

export function WaveEdge({ above, below }: { above: string; below: string }) {
  return (
    <div aria-hidden className="bleed relative h-10 overflow-hidden sm:h-14" style={{ background: above }}>
      <svg viewBox="0 0 2400 64" preserveAspectRatio="none" className="wave-drift-slow absolute inset-y-0 left-0 h-full w-[200%] opacity-25">
        <path d={WAVE} fill={below} transform="translate(0 -6)" />
      </svg>
      <svg viewBox="0 0 2400 64" preserveAspectRatio="none" className="wave-drift absolute inset-y-0 left-0 h-full w-[200%]">
        <path d={WAVE} fill={below} />
      </svg>
    </div>
  );
}
