// QrCode.tsx — the pairing link as a QR, drawn as one SVG path so it stays crisp and takes the ink colour.

import { encode } from "uqr";

export function QrCode({ value, className = "" }: { value: string; className?: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  let d = "";
  data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} shapeRendering="crispEdges" role="img" aria-label="QR code for the pairing link">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="var(--ink)" />
    </svg>
  );
}
