// Countdown.tsx — time left until `to`, ticking once a second in the browser. The server renders the same text from
// its own clock; the first client tick replaces it, so the markup never waits on JavaScript.

import { useEffect, useState } from "react";
import { duration } from "../lib/format.ts";

export function useNow(everyMs = 1000, initial?: number) {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export function Countdown({ to, serverNow, className = "" }: { to: number; serverNow: number; className?: string }) {
  const now = useNow(1000, serverNow);
  return (
    <time dateTime={new Date(to).toISOString()} className={`tnum ${className}`} suppressHydrationWarning>
      {duration(to - now)}
    </time>
  );
}
