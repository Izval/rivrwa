// profiles.ts — the three mandate presets the form offers. A profile sets two limits: the widest band River may
// use and how far price may drift from entry before River leaves early.
//
// The replay (research/gate0/sim-core.ts, 2026-09-29) shows IVL bands of ±0.9–1.6% on NVDAB, with ±3% only as the
// short-history fallback. So the width cap rarely binds; it is a guard for thin or wild history. What really
// separates the profiles is the drift exit. The replay does not model early exits (it always leaves at the window's
// end), so the copy describes behaviour and makes no claims about returns.

export interface Profile {
  id: "cautious" | "base" | "patient";
  name: string;
  summary: string;
  maxHalfWidth: number;
  exitOnDrift: number;
}

export const PROFILES: readonly Profile[] = [
  {
    id: "cautious", name: "Cautious", maxHalfWidth: 0.03, exitOnDrift: 0.02,
    summary: "Leaves soon after price moves out of the band, so your share count changes least.",
  },
  {
    id: "base", name: "Base", maxHalfWidth: 0.05, exitOnDrift: 0.03,
    summary: "River's default. Gives price some room to come back before leaving.",
  },
  {
    id: "patient", name: "Patient", maxHalfWidth: 0.08, exitOnDrift: 0.05,
    summary: "Stays through bigger weekend moves, waiting for price to return. Shares can shift more.",
  },
];

export const DEFAULT_PROFILE = PROFILES[1];

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The preset a saved mandate matches, or null when its knobs were set by hand. */
export const profileOf = (maxHalfWidth: number, exitOnDrift: number) =>
  PROFILES.find((p) => close(p.maxHalfWidth, maxHalfWidth) && close(p.exitOnDrift, exitOnDrift)) ?? null;
