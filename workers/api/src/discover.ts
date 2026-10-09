// discover.ts — enables stocks by itself. Once a day it lists every PancakeSwap v3 pool that Binance's DeFi API
// knows for the tokens in the catalog (one call per ~40 tokens), keeps the deepest pool against USDT per stock,
// and queues those with enough TVL. Each cron run then reviews a few of them: pool facts from the chain,
// hourly history from GeckoTerminal, and the Gate 0 replay (packages/core/src/gate.ts). The result goes into
// the registry in KV, which the agent reads before every tick. Enabling and demotion rules: core registry.ts.
//
// GeckoTerminal's free tier (~30 req/min) paces the reviews: up to 6 history pages per stock, 2.5 s apart.

import {
  ASSETS, GATE_RULES, applyGate, assetFromPool, binanceWeb3, fetchOhlcvHistory, fillGaps, gateReport, mergeRegistry,
  pickPool, poolMeta, tickLiquidity, type Candle, type InvestmentListItem, type PoolSnapshot, type Registry, type RegistryAsset,
  type StockStatus, type StreamAsset,
} from "../../../packages/core/src/index.ts";
import { egressFetch, type EgressNamespace } from "../../agent/src/egress.ts";
import { REGISTRY_KEY, forgetRegistry, storedRegistry } from "../../agent/src/registry.ts";

export interface DiscoverEnv {
  RIVER_KV: KVNamespace;
  BAW?: EgressNamespace;
  BINANCE_WEB3_API_KEY?: string;
  BINANCE_WEB3_SECRET_KEY?: string;
}

export interface CatalogToken { token: string; symbol: string; underlying: string }
interface Candidate extends CatalogToken { investmentId: string; tvl: number; attempts?: number }
interface DiscoverState { queue: Candidate[]; sweepStartedAt: number | null; lastSweepAt: number | null }

const STATE_KEY = "discover:state";

/** What the simulator replays: the reviewed stock's hourly history and pool snapshot, as of its last review. */
export interface GateInputs { at: number; asset: StreamAsset; snapshot: PoolSnapshot; candles: [number, number, number, number, number, number][] }
export const inputsKey = (token: string) => `gate:inputs:${token}`;
export const candlesOf = (i: GateInputs): Candle[] => fillGaps(i.candles.map(([ts, o, h, l, c, vol]) => ({ ts, o, h, l, c, vol })), 3600);
const SWEEP_EVERY_MS = 24 * 3_600_000;
const PER_RUN = 3;

const bwFor = (env: DiscoverEnv) => {
  if (!env.BINANCE_WEB3_API_KEY || !env.BINANCE_WEB3_SECRET_KEY) throw new Error("Binance Web3 keys are not set");
  return binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW));
};

const emptyRegistry = (): Registry => ({ at: 0, assets: [], status: {} });
const status = (state: StockStatus["state"], reason: string | null): StockStatus => ({ state, reason, at: Date.now() });

/** Lists pools for the catalog and returns the stocks worth a full review; records why the others are not. */
export async function listCandidates(env: DiscoverEnv, catalog: CatalogToken[], reg: Registry): Promise<Candidate[]> {
  const bw = bwFor(env);
  const items: InvestmentListItem[] = [];
  for (let i = 0; i < catalog.length; i += 40) {
    const tokens = catalog.slice(i, i + 40).map((c) => c.token);
    for (let page = 1; page <= 10; page++) {
      const r = await bw.investmentList(tokens, page, 100);
      items.push(...r.list);
      if (r.list.length < 100 || page * 100 >= r.total) break;
    }
  }
  const out: Candidate[] = [];
  for (const c of catalog) {
    const pool = pickPool(items, c.symbol);
    if (!pool) { reg.status[c.token] = status("not_eligible", "no PancakeSwap v3 pool against USDT"); continue; }
    const tvl = +pool.tvl;
    const pinned = ASSETS.some((a) => a.pinned && a.token === c.token);
    if (tvl < GATE_RULES.minTvlUsd && !pinned) {
      reg.status[c.token] = status("not_eligible", `pool TVL $${Math.round(tvl).toLocaleString("en-US")} is below $${GATE_RULES.minTvlUsd.toLocaleString("en-US")}`);
      continue;
    }
    out.push({ ...c, investmentId: pool.investmentId, tvl });
    if (!reg.status[c.token] || reg.status[c.token].state !== "running") reg.status[c.token] = status("reviewing", "queued for the Gate 0 replay");
  }
  return out;
}

/** Full review of one stock: pool facts, history, gate. Updates `reg` in place and returns the new entry. */
export async function review(env: DiscoverEnv, c: Candidate, reg: Registry): Promise<RegistryAsset | null> {
  const bw = bwFor(env);
  const detail = await bw.investmentDetail(c.investmentId);
  const rpc = { fetchImpl: egressFetch(env.BAW) }; // public RPCs rate-limit Workers' egress
  const meta = await poolMeta(detail.poolAddress, rpc);
  const seed = ASSETS.find((a) => a.token === c.token);
  const found = assetFromPool({
    symbol: c.symbol, underlying: c.underlying, token: c.token, pool: detail.poolAddress, investmentId: c.investmentId,
    token0: meta.token0, token1: meta.token1, fee: meta.fee, tickSpacing: meta.tickSpacing,
  });
  if (!found) { reg.status[c.token] = status("not_eligible", "the listed pool is not paired with USDT"); return null; }
  // A pinned stock keeps its curated entry; a discovered one uses what the chain and Binance say today.
  const base = seed?.pinned ? seed : { ...found, pinned: false };
  const net = await tickLiquidity(detail.poolAddress, meta.tick, meta.tickSpacing, 0.08, rpc);
  const raw = await fetchOhlcvHistory(detail.poolAddress, c.token, { fetchImpl: egressFetch(env.BAW) });
  const h1 = fillGaps(raw, 3600);
  if (h1.length < 24 * 14) { reg.status[c.token] = status("not_eligible", "less than two weeks of trading history"); return null; }
  const snapshot: PoolSnapshot = { tick: meta.tick, liquidity: meta.liquidity, net };
  const inputs: GateInputs = { at: Date.now(), asset: base, snapshot, candles: raw.map((k) => [k.ts, k.o, k.h, k.l, k.c, k.vol]) };
  await env.RIVER_KV.put(inputsKey(c.token), JSON.stringify(inputs));
  const report = gateReport({
    asset: base, h1, snapshot,
    tvlUsd: +detail.tvl || c.tvl, decimalsOk: meta.decimals0 === 18 && meta.decimals1 === 18,
  });
  const prev = reg.assets.find((a) => a.token === c.token);
  const next = applyGate(base, prev, report);
  reg.assets = [...reg.assets.filter((a) => a.token !== c.token), next];
  reg.status[c.token] = next.enabled
    ? status("running", report.pass ? null : `passing on the last review; ${report.reasons.join("; ")}`)
    : status("not_eligible", report.reasons.join("; "));
  return next;
}

/** One cron step: start a sweep when due, then review the next few candidates. */
export async function discoverStep(env: DiscoverEnv, catalog: () => Promise<CatalogToken[]>, perRun = PER_RUN): Promise<{ reviewed: string[]; queued: number }> {
  const reg = (await storedRegistry(env)) ?? emptyRegistry();
  const st = (await env.RIVER_KV.get<DiscoverState>(STATE_KEY, "json")) ?? { queue: [], sweepStartedAt: null, lastSweepAt: null };
  if (st.queue.length === 0 && (!st.lastSweepAt || Date.now() - st.lastSweepAt > SWEEP_EVERY_MS)) {
    st.queue = await listCandidates(env, await catalog(), reg);
    st.sweepStartedAt = Date.now();
  }
  const reviewed: string[] = [];
  for (const c of st.queue.splice(0, perRun)) {
    try {
      await review(env, c, reg);
    } catch (e) {
      // Transient failures (mostly GeckoTerminal 429s) go to the back of the queue, up to three tries per sweep.
      const attempts = (c.attempts ?? 0) + 1;
      if (attempts < 3) st.queue.push({ ...c, attempts });
      reg.status[c.token] = status("reviewing", `review failed (${(e as Error).message.slice(0, 120)}); ${attempts < 3 ? "retrying later in this sweep" : "retried next sweep"}`);
    }
    reviewed.push(c.symbol);
  }
  if (st.queue.length === 0 && st.sweepStartedAt) { st.lastSweepAt = Date.now(); st.sweepStartedAt = null; }
  await save(env, reg);
  await env.RIVER_KV.put(STATE_KEY, JSON.stringify(st));
  return { reviewed, queued: st.queue.length };
}

/** Reviews one token now (admin trigger), outside the sweep. */
export async function discoverToken(env: DiscoverEnv, c: CatalogToken): Promise<{ status: StockStatus | undefined; asset: RegistryAsset | null }> {
  const reg = (await storedRegistry(env)) ?? emptyRegistry();
  const [cand] = await listCandidates(env, [c], reg);
  const asset = cand ? await review(env, cand, reg) : null;
  await save(env, reg);
  return { status: reg.status[c.token], asset };
}

async function save(env: DiscoverEnv, reg: Registry) {
  reg.at = Date.now();
  reg.assets = mergeRegistry(reg);
  await env.RIVER_KV.put(REGISTRY_KEY, JSON.stringify(reg));
  forgetRegistry();
}
