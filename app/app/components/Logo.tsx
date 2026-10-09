// Logo.tsx — River's mark: two strokes of a current, the lower one a beat behind, beside the wordmark.

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 28 20" className="h-5 w-7" aria-hidden>
        <path d="M2 7c4-4 8-4 12 0s8 4 12 0" fill="none" stroke="var(--river)" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M2 14c4-4 8-4 12 0s8 4 12 0" fill="none" stroke="var(--river)" strokeOpacity=".4" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className="text-[19px] font-bold tracking-[-0.02em]">River</span>
    </span>
  );
}
