// simguard.ts — the second check before River signs: Binance's Transaction API dry-runs each call, and River reads
// what actually moved.
//
// `npmGuard` (npm.ts) reads calldata: right contract, right selector, recipient = the account. It cannot see what
// the call *does* on-chain. Binance's `pre-transaction/simulate` can: it returns every token balance and allowance
// the call would change. For a liquidity cycle the only legal movements are between the user's own account and the
// pool (mint: account → pool; collect: pool → account; decreaseLiquidity moves nothing), and no allowance may change
// except to the NPM. Anything else — a third address gaining tokens, a new approval — means the calldata is not
// what River thinks it is, so River refuses to sign it. A revert in the simulation is refused too: better to learn
// it here than to pay gas for it.

import type { SimulateResult } from "./binance.ts";
import { PANCAKE_V3_NPM } from "./assets.ts";
import { GuardError, type Call } from "./npm.ts";

export function checkSimulation(sim: SimulateResult, o: { account: string; pool: string; npm?: string }): void {
  const account = o.account.toLowerCase(), pool = o.pool.toLowerCase(), npm = (o.npm ?? PANCAKE_V3_NPM).toLowerCase();
  if (sim.status !== "SUCCESS") throw new GuardError(`simulation ${sim.status}: ${sim.failReason || "no reason given"}`);
  for (const b of sim.balanceChanges ?? []) {
    const who = b.owner.toLowerCase();
    if (who !== account && who !== pool) throw new GuardError(`simulation moves ${b.change} of ${b.contractAddress} for ${who}, which is neither the account nor the pool`);
  }
  for (const a of sim.allowanceChanges ?? []) {
    if (a.spender.toLowerCase() !== npm) throw new GuardError(`simulation changes an allowance of ${a.tokenAddress} to ${a.spender}`);
  }
}

/** Simulates each call from the account and applies `checkSimulation`. Returns how many calls were checked. */
export async function simulateCalls(simulate: (tx: { from: string; to: string; data: string; value?: string }) => Promise<SimulateResult>, calls: Call[], o: { account: string; pool: string }): Promise<number> {
  for (const c of calls) checkSimulation(await simulate({ from: o.account, to: c.to, data: c.data, value: String(BigInt(c.value ?? "0x0")) }), o);
  return calls.length;
}
