// store.ts — the runner's memory between ticks: the open position, a tx waiting to be mined, an exit in
// progress, and the halt flag. Every step that broadcasts is saved *before* waiting for its receipt, so a
// crash or a closed laptop never makes the runner forget a submitted tx or deposit twice.

import type { Amounts, OpenPosition, TickRange } from "../../packages/core/src/index.ts";

export interface EntryContext {
  window: string;
  range: TickRange;
  entryPrice: number;
  windowEnd: number;
  /** Wallet balances before the deposit, to report shares before/after. */
  inventoryBefore: Amounts;
}

export type Pending =
  | { kind: "add"; txHash: string; at: number; ctx: EntryContext }
  | { kind: "claim" | "remove"; txHash: string; at: number };

export interface ExitProgress {
  reason: string;
  startedAt: number;
  claimTx?: string;
  /** Fees paid out by the claim; null when the claim was skipped or failed. */
  fees?: Amounts | null;
  gasBnb: number;
}

export interface AgentState {
  position: (OpenPosition & { entry: EntryContext & { addTx: string; gasBnb: number } }) | null;
  pending: Pending | null;
  exit: ExitProgress | null;
  /** Failed entries in the current window; after 2 the window is skipped. */
  failures: { window: string; count: number } | null;
  /** Set when the runner cannot tell where the funds are. Nothing is sent until a human clears it. */
  halted: string | null;
}

export const emptyState = (): AgentState => ({ position: null, pending: null, exit: null, failures: null, halted: null });

export interface CycleRecord {
  asset: string;
  owner: string;
  signer: string;
  window: string;
  nftId: string;
  range: TickRange;
  openedAt: string;
  closedAt: string;
  exitReason: string;
  entryPrice: number;
  exitPrice: number;
  deposited: Amounts;
  withdrawn: Amounts;
  fees: Amounts;
  feesUsd: number;
  ilUsd: number;
  riverFeeUsd: number;
  gasBnb: number;
  sharesBefore: number;
  sharesAfter: number;
  txs: { add: string; claim?: string; remove: string };
}

export interface Store {
  load(): Promise<AgentState>;
  save(s: AgentState): Promise<void>;
  appendCycle(r: CycleRecord): Promise<void>;
}

export function memoryStore(initial: AgentState = emptyState()): Store & { state: AgentState; cycles: CycleRecord[] } {
  const m = {
    state: structuredClone(initial),
    cycles: [] as CycleRecord[],
    load: async () => structuredClone(m.state),
    save: async (s: AgentState) => { m.state = structuredClone(s); },
    appendCycle: async (r: CycleRecord) => { m.cycles.push(r); },
  };
  return m;
}
