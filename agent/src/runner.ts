// runner.ts — one idempotent step of River's cycle for one mandate. `tick()` is safe to call at any time and
// any number of times: it first settles a tx left pending by a previous tick, then finishes an exit in
// progress, and only then asks the planner (packages/core) what to do. The planner decides; the Signer signs.
//
// Two deviations from the plain planner, both about the real world:
//  - price: the band is centred on the pool's live tick (slot0), not the last hourly candle, because lp-add
//    derives the paired leg from the live tick.
//  - time: the window ends early if the signer's session would expire first, so the position is always
//    removed while the agent can still sign. If GeckoTerminal is down, an open position still exits on the
//    clock and on live-price drift.

import {
  computeSignal, planCycle, mintedNftId, npmAmounts, gasBnb, riverFee, impermanentLoss, USDT,
  type Action, type Amounts, type Candle, type Mandate, type Receipt, type Signal, type StreamAsset,
} from "../../packages/core/src/index.ts";
import type { LpOp, Preview, Signer } from "./signer.ts";
import type { LoadedMandate } from "./mandate.ts";
import type { AgentState, CycleRecord, Store } from "./store.ts";

export interface Deps {
  signer: Signer;
  store: Store;
  now: () => number;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Gap-filled hourly candles for the asset's pool, oldest first. */
  candles: (a: StreamAsset) => Promise<Candle[]>;
  pool: (a: StreamAsset) => Promise<{ price: number; tick: number }>;
  balance: (token: string, owner: string) => Promise<number>;
  receipt: (txHash: string) => Promise<Receipt | null>;
}

/** status: read-only, no previews. dry-run: previews every tx, never broadcasts or saves. live: executes. */
export type Mode = "status" | "dry-run" | "live";

export interface RunConfig extends LoadedMandate {
  mode: Mode;
  /** Leave the pool this long before the signer's session expires. */
  sessionMarginMs?: number;
  /** How long to poll for a receipt inside one tick before leaving it to the next. */
  receiptTimeoutMs?: number;
}

export interface TickOutcome {
  kind: Action["kind"] | "pending" | "halted" | "blocked" | "previewed" | "entered" | "exited";
  note: string;
}

const MIN = 60_000;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) + "Z" : "never");
/** Haircut on the stock leg so the paired USDT that lp-add computes at the live tick stays within budget. */
const ADD_HAIRCUT = 0.999;

export async function tick(cfg: RunConfig, d: Deps): Promise<TickOutcome> {
  const { mandate } = cfg;
  const asset = cfg.asset;
  const live = cfg.mode === "live";
  const s = await d.store.load();
  const save = async () => { if (live) await d.store.save(s); };

  if (s.halted) return { kind: "halted", note: `${s.halted} — fix it, then run \`resume\`` };

  // 1. A tx submitted earlier is settled before anything else.
  if (s.pending) {
    const r = await d.receipt(s.pending.txHash);
    if (!r) return { kind: "pending", note: `${s.pending.kind} ${s.pending.txHash} not mined yet (submitted ${Math.round((d.now() - s.pending.at) / MIN)} min ago)` };
    if (!live) return { kind: "pending", note: `${s.pending.kind} ${s.pending.txHash} mined; the next live tick records it` };
    const done = await settle(s, r, cfg, d, asset);
    await save();
    if (done) return done;
  }

  // 2. A live session, on the mandate owner's wallet.
  const session = await d.signer.session();
  for (const w of session.warnings) d.log(`warn ${w}`);
  if (!session.connected)
    return { kind: "blocked", note: `${s.position ? `POSITION ${s.position.nftId} IS OPEN and ` : ""}the signer is not connected: ${session.warnings.join("; ")}` };
  const owner = await d.signer.address();
  if (owner !== mandate.owner) return { kind: "blocked", note: `signer address ${owner} is not the mandate owner ${mandate.owner}` };
  const signEnd = session.expiresAt - (cfg.sessionMarginMs ?? 30 * MIN);

  // 3. An exit in progress is finished before any new plan (it needs neither the signal nor the clock).
  if (s.position && s.exit) return continueExit(s, cfg, d, asset, save);

  const now = d.now();
  const { price } = await d.pool(asset);
  let signal: Signal | null = null;
  try {
    const base = computeSignal(await d.candles(asset), now);
    const hw = base.band.halfWidth;
    signal = { ...base, price, band: { ...base.band, low: price * (1 - hw), high: price * (1 + hw) }, exitAt: Math.min(base.exitAt, signEnd) };
  } catch (e) {
    if (!s.position) throw e;
    d.log(`warn signal unavailable (${(e as Error).message}); exit checks use the clock and the live price only`);
  }

  let action: Action;
  if (signal) {
    const inventory = s.position ? { stock: 0, usd: 0 } : await balances(d, asset, owner);
    action = planCycle({ now, asset, signal, mandate, inventory, position: s.position, events: cfg.events });
    if (action.kind === "enter") return enter(action, { s, cfg, d, asset, signal, inventory, session, save });
  } else {
    action = fallbackExit(s, mandate, now, price, signEnd);
  }

  if (action.kind === "exit") {
    if (cfg.mode === "status") return { kind: "exit", note: `would exit ${action.nftId}: ${action.reason}` };
    s.exit = { reason: action.reason, startedAt: now, gasBnb: 0 };
    await save();
    return continueExit(s, cfg, d, asset, save);
  }
  if (action.kind === "hold") {
    const p = s.position!;
    const inRange = price >= p.range.priceLow && price <= p.range.priceHigh;
    return { kind: "hold", note: `${asset.symbol} ${price.toFixed(2)} ${inRange ? "in" : "OUT OF"} range [${p.range.priceLow.toFixed(2)}, ${p.range.priceHigh.toFixed(2)}], drift ${pct(price / p.entryPrice - 1)}, exit at ${iso(Math.min(signal?.exitAt ?? Infinity, p.windowEnd))}` };
  }
  const note = action.kind === "wait" ? `${action.reason}; entry at ${iso(action.until)}` : action.kind === "skip" ? action.reason : "";
  return { kind: action.kind, note };
}

async function balances(d: Deps, asset: StreamAsset, owner: string): Promise<Amounts> {
  const [stock, usdt] = await Promise.all([d.balance(asset.token, owner), d.balance(USDT, owner)]);
  return { stock, usd: usdt };
}

/** Exit rules that need no signal: the window (or session) is closing, price drifted, or the mandate expired. */
function fallbackExit(s: AgentState, m: Mandate, now: number, price: number, signEnd: number): Action {
  const p = s.position!;
  if (now >= m.expiresAt) return { kind: "exit", nftId: p.nftId, reason: "mandate_expired" };
  if (now >= Math.min(p.windowEnd, signEnd)) return { kind: "exit", nftId: p.nftId, reason: "window_closing" };
  if (Math.abs(price / p.entryPrice - 1) >= m.exitOnDrift) return { kind: "exit", nftId: p.nftId, reason: "drift" };
  return { kind: "hold", reason: "signal unavailable; inside window, within drift" };
}

async function enter(
  action: Extract<Action, { kind: "enter" }>,
  x: { s: AgentState; cfg: RunConfig; d: Deps; asset: StreamAsset; signal: Signal; inventory: Amounts; session: { quotaUsd?: number }; save: () => Promise<void> },
): Promise<TickOutcome> {
  const { s, cfg, d, asset, signal, inventory } = x;
  const window = signal.clock.window.lastTradingDay;
  const valueUsd = action.deposit.stock * signal.price + action.deposit.usd;
  const desc = `${asset.symbol} ${action.deposit.stock.toFixed(4)} + ${usd(action.deposit.usd)} (${usd(valueUsd)}) into [${action.range.priceLow.toFixed(2)}, ${action.range.priceHigh.toFixed(2)}] ticks ${action.range.tickLower}..${action.range.tickUpper}, ${action.reason}`;

  if (s.failures?.window === window && s.failures.count >= 2) return { kind: "skip", note: `2 failed entries in the ${window} window; skipping it` };
  if (!(action.deposit.stock > 0) || valueUsd < 1) return { kind: "skip", note: `nothing to deposit (the band needs some ${asset.symbol} and USDT)` };
  if (x.session.quotaUsd !== undefined && valueUsd > x.session.quotaUsd)
    return { kind: "skip", note: `deposit ${usd(valueUsd)} exceeds the wallet's DeFi quota left today (${usd(x.session.quotaUsd)}); raise it in the Binance App` };
  if (cfg.mode === "status") return { kind: "enter", note: `would enter: ${desc}` };

  // Preview, and shrink once if the live tick asks for more USDT than the mandate allocates.
  const usdBudget = inventory.usd * cfg.mandate.allocation;
  let op: LpOp = { kind: "add", asset, range: action.range, token: asset.token, amount: action.deposit.stock * ADD_HAIRCUT, slippageBps: cfg.slippageBps };
  let pv = await d.signer.preview(op);
  let usdOut = outflow(pv, USDT);
  if (usdOut > usdBudget) {
    op = { ...op, amount: op.amount * (usdBudget / usdOut) * 0.995 };
    pv = await d.signer.preview(op);
    usdOut = outflow(pv, USDT);
    if (usdOut > usdBudget) return { kind: "skip", note: `lp-add would take ${usd(usdOut)} USDT, over the ${usd(usdBudget)} allocated` };
  }
  for (const w of pv.warnings) d.log(`warn preview: ${w}`);
  const previewNote = `lp-add ${op.amount.toFixed(4)} ${asset.symbol} + ${usdOut.toFixed(2)} USDT`;
  if (cfg.mode === "dry-run") return { kind: "previewed", note: `${previewNote} — ${desc}` };

  const txHash = await d.signer.execute(op);
  s.pending = { kind: "add", txHash, at: d.now(), ctx: { window, range: action.range, entryPrice: signal.price, windowEnd: signal.exitAt, inventoryBefore: inventory } };
  await x.save();
  d.log(`lp-add submitted ${txHash}: ${previewNote}`);
  const r = await mined(txHash, cfg, d);
  if (!r) return { kind: "pending", note: `lp-add ${txHash} submitted, not mined yet` };
  const done = await settle(s, r, cfg, d, asset);
  await x.save();
  return done ?? { kind: "entered", note: `position ${s.position!.nftId}: ${desc}` };
}

async function continueExit(s: AgentState, cfg: RunConfig, d: Deps, asset: StreamAsset, save: () => Promise<void>): Promise<TickOutcome> {
  const p = s.position!, ex = s.exit!;
  const claim: LpOp = { kind: "claim", asset, nftId: p.nftId };
  const remove: LpOp = { kind: "remove", asset, nftId: p.nftId, slippageBps: cfg.slippageBps };
  if (cfg.mode === "status") return { kind: "exit", note: `exit of ${p.nftId} in progress (${ex.reason})` };

  // Fees first, so the cycle report can tell fees from principal. A failed claim is not fatal: lp-remove
  // collects whatever is owed anyway, and the report then derives fees from the remove receipt.
  if (ex.fees === undefined) {
    try {
      const pv = await d.signer.preview(claim);
      if (cfg.mode === "dry-run") {
        const pr = await d.signer.preview(remove);
        return { kind: "previewed", note: `exit ${p.nftId} (${ex.reason}): claim ${fmtChange(pv)}; remove ${fmtChange(pr)}` };
      }
      const txHash = await d.signer.execute(claim);
      s.pending = { kind: "claim", txHash, at: d.now() };
      await save();
      d.log(`claim submitted ${txHash}`);
      const r = await mined(txHash, cfg, d);
      if (!r) return { kind: "pending", note: `claim ${txHash} submitted, not mined yet` };
      await settle(s, r, cfg, d, asset);
      await save();
    } catch (e) {
      if (cfg.mode === "dry-run") throw e;
      d.log(`warn claim failed, removing anyway: ${(e as Error).message}`);
      ex.fees = null;
      await save();
    }
  }

  const pv = await d.signer.preview(remove);
  if (cfg.mode === "dry-run") return { kind: "previewed", note: `exit ${p.nftId} (${ex.reason}): remove ${fmtChange(pv)}` };
  const txHash = await d.signer.execute(remove);
  s.pending = { kind: "remove", txHash, at: d.now() };
  await save();
  d.log(`lp-remove submitted ${txHash}`);
  const r = await mined(txHash, cfg, d);
  if (!r) return { kind: "pending", note: `lp-remove ${txHash} submitted, not mined yet` };
  const done = await settle(s, r, cfg, d, asset);
  await save();
  return done ?? { kind: "exited", note: "cycle closed" };
}

/** Apply a mined receipt for `s.pending`. Returns an outcome when the tick should stop there. */
async function settle(s: AgentState, r: Receipt, cfg: RunConfig, d: Deps, asset: StreamAsset): Promise<TickOutcome | null> {
  const pend = s.pending!;
  const ok = r.status === "0x1";
  s.pending = null;
  const owner = cfg.mandate.owner;

  if (pend.kind === "add") {
    if (!ok) {
      const w = pend.ctx.window;
      s.failures = { window: w, count: s.failures?.window === w ? s.failures.count + 1 : 1 };
      return { kind: "skip", note: `lp-add ${pend.txHash} reverted (${s.failures.count} this window)` };
    }
    const nftId = mintedNftId(r, owner);
    if (!nftId) {
      s.halted = `lp-add ${pend.txHash} was mined but no position NFT was minted to ${owner}; check \`baw defi position\` and the tx on BscScan`;
      return { kind: "halted", note: s.halted };
    }
    s.position = {
      nftId, openedAt: d.now(), entryPrice: pend.ctx.entryPrice, range: pend.ctx.range,
      entryAmounts: npmAmounts(r, "increase", nftId, asset), windowEnd: pend.ctx.windowEnd,
      entry: { ...pend.ctx, addTx: pend.txHash, gasBnb: gasBnb(r) },
    };
    d.log(`position ${nftId} open: ${s.position.entryAmounts.stock.toFixed(4)} ${asset.symbol} + ${usd(s.position.entryAmounts.usd)}`);
    return null;
  }

  const ex = s.exit!;
  ex.gasBnb += gasBnb(r);
  if (pend.kind === "claim") {
    ex.claimTx = pend.txHash;
    ex.fees = ok ? npmAmounts(r, "collect", s.position!.nftId, asset) : null;
    if (!ok) d.log(`warn claim ${pend.txHash} reverted; fees will be derived from the remove`);
    return null;
  }

  if (!ok) return { kind: "exit", note: `lp-remove ${pend.txHash} reverted; retrying on the next tick` };
  return finishCycle(s, r, cfg, d, asset);
}

async function finishCycle(s: AgentState, r: Receipt, cfg: RunConfig, d: Deps, asset: StreamAsset): Promise<TickOutcome> {
  const p = s.position!, ex = s.exit!;
  const owner = cfg.mandate.owner;
  const withdrawn = npmAmounts(r, "decrease", p.nftId, asset);
  const paid = npmAmounts(r, "collect", p.nftId, asset);
  // Whatever the remove paid beyond the released principal is fees that the claim did not take.
  const fees = {
    stock: (ex.fees?.stock ?? 0) + Math.max(0, paid.stock - withdrawn.stock),
    usd: (ex.fees?.usd ?? 0) + Math.max(0, paid.usd - withdrawn.usd),
  };
  const [{ price: exitPrice }, sharesAfter] = await Promise.all([d.pool(asset), d.balance(asset.token, owner)]);
  const feesUsd = fees.stock * exitPrice + fees.usd;
  const rec: CycleRecord = {
    asset: asset.symbol, owner, signer: d.signer.kind, window: p.entry.window, nftId: p.nftId, range: p.range,
    openedAt: new Date(p.openedAt).toISOString(), closedAt: new Date(d.now()).toISOString(), exitReason: ex.reason,
    entryPrice: p.entryPrice, exitPrice, deposited: p.entryAmounts, withdrawn, fees, feesUsd,
    ilUsd: impermanentLoss(p.entryAmounts, withdrawn, exitPrice), riverFeeUsd: riverFee(feesUsd),
    gasBnb: p.entry.gasBnb + ex.gasBnb, sharesBefore: p.entry.inventoryBefore.stock, sharesAfter,
    txs: { add: p.entry.addTx, claim: ex.claimTx, remove: r.transactionHash },
  };
  if (cfg.mode === "live") await d.store.appendCycle(rec);
  s.position = null;
  s.exit = null;
  return {
    kind: "exited",
    note: `cycle ${p.nftId} closed (${ex.reason}): fees ${usd(feesUsd)}, IL ${usd(rec.ilUsd)}, River fee ${usd(rec.riverFeeUsd)}, shares ${rec.sharesBefore.toFixed(4)} → ${sharesAfter.toFixed(4)}`,
  };
}

/** Poll for a receipt inside this tick; null means "still pending", left to the next tick. */
async function mined(txHash: string, cfg: RunConfig, d: Deps): Promise<Receipt | null> {
  const polls = Math.ceil((cfg.receiptTimeoutMs ?? 3 * MIN) / 3000);
  for (let i = 0; ; i++) {
    const r = await d.receipt(txHash);
    if (r || i >= polls) return r;
    await d.sleep(3000);
  }
}

const outflow = (pv: Preview, token: string) => Math.max(0, -(pv.balanceChange.find((b) => b.token === token.toLowerCase())?.amount ?? 0));
const fmtChange = (pv: Preview) => pv.balanceChange.map((b) => `${b.amount > 0 ? "+" : ""}${b.amount} ${b.symbol}`).join(", ") || "no balance change reported";
