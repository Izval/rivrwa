// River public API (Cloudflare Worker). Read-only and keyless for callers; the Binance keys
// stay server-side. Everything here is computed by packages/core, the same code the agent runs.
//
//   GET  /v1/health
//   GET  /v1/clock                 -> current phase + the next closed windows
//   GET  /v1/assets                -> stream registry + live RWA status/price (Binance RWA Data)
//   GET  /v1/stocks                -> every tokenized stock Binance lists on BSC, and whether River runs it
//   GET  /v1/gate/:symbol          -> the latest automatic Gate 0 review of a stock
//   GET  /v1/simulate?symbol=&size=&x=1|2|4  -> what River would have added over the past windows (enabled only)
//   POST /v1/discover[?token=0x…]  -> admin: run a discovery step now, or review one token (x-admin-key)
//   GET  /v1/signals               -> signal for every enabled asset (cached, cron-refreshed)
//   GET  /v1/signal/:symbol        -> when (closed window) + where (band) for one asset
//   POST /v1/plan                  -> planCycle(mandate, inventory, position) for agents
//   GET  /v1/backtest              -> Gate 0 production-replay summary (transparency page)
//   GET  /v1/agent                 -> River as an agent: ERC-8004 identity, treasury (x402 revenue), public cycles
//   GET  /v1/paid/plan?symbol=&stock=&usd=[&maxHalfWidth=]  -> x402: a cycle plan fitted to the caller's inventory
//   POST /mcp                      -> MCP tools (get_weekend_window, list_assets, get_range, get_cycle_report, plan_cycle)
//   GET  /.well-known/agent-registration.json  -> the ERC-8004 registration file the on-chain agentURI points at

import {
  clockState, closedWindowsBetween, computeSignal, fetchOhlcvHistory, fillGaps,
  planCycle, binanceWeb3, fetchBinanceHistory, resolveAsset, simulate, RIVER_FEE, type Mandate, type OpenPosition, type RegistryAsset, type Signal,
} from "../../../packages/core/src/index.ts";
import { egressFetch } from "../../agent/src/egress.ts";
import { loadRegistry, storedRegistry } from "../../agent/src/registry.ts";
import { candlesOf, discoverStep, discoverToken, inputsKey, type CatalogToken, type GateInputs } from "./discover.ts";
import { agentRegistration, encodeHeader, erc20Balance, ERC8004, HEADERS, rpc, USDT } from "../../../packages/core/src/index.ts";
import { handleMcp, InvalidParams, PaymentRequired, type McpTool } from "./mcp.ts";
import { charge, PLAN_PRICE_USD, TREASURY_KEY, type Proof, type Treasury } from "./paid.ts";

export interface Env {
  RIVER_KV: KVNamespace;
  /** The agent's baw container class: its egress reaches Binance and GeckoTerminal, which refuse Workers'. */
  BAW?: DurableObjectNamespace;
  ALLOWED_ORIGIN: string;
  BINANCE_WEB3_API_KEY?: string;
  BINANCE_WEB3_SECRET_KEY?: string;
  /** Guards POST /v1/discover. */
  ADMIN_KEY?: string;
  /** River's agent wallet: owns the ERC-8004 identity and receives x402 payments. Paid plans are off without it. */
  AGENT_WALLET?: string;
  /** The ERC-8004 agent id, once the operator has sent `register` (scripts/register-agent.ts). */
  AGENT_ID?: string;
  BSC_RPC_URL?: string;
}

/** The crons: signals and the catalog every 15 minutes; one discovery step at minutes 7/22/37/52. */
const DISCOVERY_CRON = "7-59/15 * * * *";

const SIGNAL_TTL_S = 15 * 60;
const RL_LIMIT = 120, RL_WINDOW_S = 60;

const cors = (env: Env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT-TX, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, MCP-Protocol-Version",
  Vary: "Origin",
});

const json = (env: Env, body: unknown, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...cors(env) },
  });

// Per-IP fixed-window rate limit via the Cache API (free, per-colo, best-effort).
async function underRateLimit(req: Request): Promise<boolean> {
  const ip = req.headers.get("CF-Connecting-IP") || "anon";
  const key = new Request(`${new URL(req.url).origin}/__rl/${encodeURIComponent(ip)}/${Math.floor(Date.now() / 1000 / RL_WINDOW_S)}`);
  const hit = await caches.default.match(key);
  const n = (hit ? parseInt(await hit.text(), 10) || 0 : 0) + 1;
  if (n > RL_LIMIT) return false;
  await caches.default.put(key, new Response(String(n), { headers: { "Cache-Control": `max-age=${RL_WINDOW_S}` } }));
  return true;
}

/** `retries`: the cron waits out GeckoTerminal 429s; a web request never does (it serves stale or nothing). */
async function freshSignal(env: Env, a: RegistryAsset, retries = 0): Promise<Signal> {
  // One page (1000 h) is enough for the signal; the history helper adds the 429 backoff.
  const h1 = fillGaps(await fetchOhlcvHistory(a.pool, a.token, { pages: 1, retries, fetchImpl: egressFetch(env.BAW) }), 3600);
  return computeSignal(h1);
}

/** Last resort when GeckoTerminal fails and nothing is cached: Binance Market's token candles (across venues, so
 *  the band comes out narrower than the pool's; research/README notes it). The signal says which source it used. */
async function binanceSignal(env: Env, a: RegistryAsset): Promise<Signal & { source: string }> {
  if (!env.BINANCE_WEB3_API_KEY || !env.BINANCE_WEB3_SECRET_KEY) throw new Error("no Binance keys for the fallback");
  const bw = binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW));
  return { ...computeSignal(fillGaps(await fetchBinanceHistory(bw, a.token), 3600)), source: "binance_market" };
}

async function cachedSignal(env: Env, a: RegistryAsset): Promise<Signal> {
  const key = `signal:${a.symbol}`;
  const hit = await env.RIVER_KV.get<Signal>(key, "json");
  if (hit && Date.now() - hit.asOf < SIGNAL_TTL_S * 1000) return hit;
  try {
    const s = await freshSignal(env, a);
    await env.RIVER_KV.put(key, JSON.stringify(s), { expirationTtl: 7 * 86400 });
    return s;
  } catch (e) {
    if (hit) return hit; // stale-serve beats an error when GeckoTerminal rate-limits
    return binanceSignal(env, a).catch(() => { throw e; });
  }
}

// The stock catalog syncs itself from Binance RWA Data, so a newly listed stock shows up without a deploy. River
// runs the assets enabled in the live registry, which the discovery cron keeps (discover.ts).
export interface StockListing {
  symbol: string;
  underlying: string;
  issuer: "bStocks" | "Ondo";
  token: string;
  logo: string | null;
  price: number | null;
  river: "running" | "watching";
  /** From discovery: running, reviewing (queued or in review) or not_eligible (with the reason). */
  state: "running" | "reviewing" | "not_eligible" | "unreviewed";
  reason: string | null;
}
const ISSUERS = [["bstock", "bStocks"], ["ondo", "Ondo"]] as const;

async function freshCatalog(env: Env): Promise<{ asOf: number; source: string; stocks: StockListing[] }> {
  const out: StockListing[] = [];
  const reg = await storedRegistry(env);
  const assets = await loadRegistry(env, 0);
  const listing = (token: string): Pick<StockListing, "river" | "state" | "reason"> => {
    const running = assets.some((a) => a.token === token && a.enabled);
    const st = reg?.status[token];
    return { river: running ? "running" : "watching", state: running ? "running" : st?.state === "running" ? "reviewing" : st?.state ?? "unreviewed", reason: running ? null : st?.reason ?? null };
  };
  let source = "registry";
  if (env.BINANCE_WEB3_API_KEY && env.BINANCE_WEB3_SECRET_KEY) {
    const bw = binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW));
    for (const [platform, issuer] of ISSUERS) {
      const toks = await bw.rwaTokens(platform).catch(() => []);
      if (toks.length) source = "binance_rwa_data";
      for (const t of toks) {
        const token = t.tokenContractAddress.toLowerCase();
        out.push({ symbol: t.tokenSymbol, underlying: t.underlyingTicker, issuer, token, logo: t.tokenLogoUrl || null, price: +t.tokenPrice || null, ...listing(token) });
      }
    }
  }
  for (const a of assets) if (!out.some((o) => o.token === a.token)) {
    out.push({ symbol: a.symbol, underlying: a.underlying, issuer: "bStocks", token: a.token, logo: null, price: null, ...listing(a.token) });
  }
  out.sort((x, y) => (x.river === y.river ? x.symbol.localeCompare(y.symbol) : x.river === "running" ? -1 : 1));
  return { asOf: Date.now(), source, stocks: out };
}

async function cachedCatalog(env: Env) {
  const hit = await env.RIVER_KV.get<{ asOf: number; source: string; stocks: StockListing[] }>("catalog", "json");
  if (hit && Date.now() - hit.asOf < SIGNAL_TTL_S * 1000) return hit;
  try {
    const c = await freshCatalog(env);
    await env.RIVER_KV.put("catalog", JSON.stringify(c), { expirationTtl: 7 * 86400 });
    return c;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

async function refreshAll(env: Env) {
  await env.RIVER_KV.put("catalog", JSON.stringify(await freshCatalog(env)), { expirationTtl: 7 * 86400 }).catch(() => {});
  for (const a of (await loadRegistry(env, 0)).filter((x) => x.enabled)) {
    try {
      const s = await freshSignal(env, a, 2);
      await env.RIVER_KV.put(`signal:${a.symbol}`, JSON.stringify(s), { expirationTtl: 7 * 86400 });
    } catch (e) {
      console.warn(`signal ${a.symbol}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 2500)); // GeckoTerminal free tier: ~30 req/min
  }
}

/** Discovery reads the catalog's token list (bStocks and Ondo) from the cached catalog. */
const catalogTokens = async (env: Env): Promise<CatalogToken[]> =>
  (await cachedCatalog(env)).stocks.map((s) => ({ token: s.token, symbol: s.symbol, underlying: s.underlying }));

const BACKTEST = {
  source: "research/gate0 (sim-core.ts): production signal (IVL μ±2σ band) + planner replayed over every closed window since pool launch",
  ivl: "research/ivl-study: the IVL band lifted net APR +41–81% vs the excursion band in all 6 scenarios",
  costs: "impermanent loss, gas, River fee (5% of LP fees + $0.25/cycle), restore to the same share count",
  sizeUsd: 10_000,
  rows: [
    { asset: "NVDAB", windows: 8, netAprBase: 67.7, netAprOthersX2: 29.3, netAprOthersX4: 9.7, winRateBase: 100 },
    { asset: "TSLAB", windows: 8, netAprBase: 39.6, netAprOthersX2: 18.8, netAprOthersX4: 8.1, winRateBase: 100 },
  ],
  control: "The same LP during weekday windows lost money in most scenarios: the market clock is the edge.",
  caveats: ["short sample (8–9 windows)", "other-LP liquidity is a snapshot", "weekend volume is volatile"],
};

const PUBLIC_CYCLES_KEY = "public:cycles"; // written by the agent Worker (workers/agent/src/db.ts)

/** The paid product: planCycle on the caller's inventory. Outside a window it also previews the entry at today's price. */
async function fittedPlan(env: Env, registry: RegistryAsset[], a: { symbol?: unknown; stock?: unknown; usd?: unknown; maxHalfWidth?: unknown }) {
  const asset = resolveAsset(registry, String(a.symbol ?? "")) as RegistryAsset | undefined;
  if (!asset) throw new InvalidParams(`unknown asset ${String(a.symbol)}; see list_assets`);
  const stock = Number(a.stock), usd = Number(a.usd);
  if (!(stock >= 0) || !(usd >= 0) || stock + usd <= 0) throw new InvalidParams("stock and usd must be non-negative amounts, not both zero");
  const maxHalfWidth = Math.min(0.2, Math.max(0.005, Number(a.maxHalfWidth) || 0.05));
  const signal = await cachedSignal(env, asset);
  const now = Date.now();
  const mandate: Mandate = { owner: "x402", asset: asset.symbol, allocation: 1, maxHalfWidth, exitOnDrift: 0.03, skipEvents: false, restoreShares: false, expiresAt: now + 14 * 86400e3 };
  const input = { asset, signal, mandate, inventory: { stock, usd }, position: null };
  const action = planCycle({ ...input, now });
  const preview = action.kind === "wait"
    ? planCycle({ ...input, now: signal.entryAt, signal: { ...signal, clock: { ...signal.clock, phase: "closed_window" } } })
    : null;
  const enter = action.kind === "enter" ? action : preview?.kind === "enter" ? preview : null;
  return {
    symbol: asset.symbol, asOf: signal.asOf, price: signal.price,
    window: { phase: signal.clock.phase, reason: signal.clock.window.reason, entryAt: new Date(signal.entryAt).toISOString(), exitAt: new Date(signal.exitAt).toISOString() },
    band: signal.band, ivl: signal.ivl,
    action, previewAtTodaysPrice: preview,
    pool: { address: asset.pool, feeTier: asset.feeTier, tickSpacing: asset.tickSpacing, stockIsToken0: asset.stockIsToken0, stock: asset.token, usd: USDT },
    // What to send to Binance's DeFi API (`/api/v1/defi/transaction/lp-add`) with your own address.
    binanceLpAdd: enter ? { investmentId: asset.investmentId, tickLower: String(enter.range.tickLower), tickUpper: String(enter.range.tickUpper), tokenList: [{ tokenAddress: asset.token, amount: enter.deposit.stock.toFixed(6) }] } : null,
    exitBy: new Date(signal.exitAt).toISOString(),
    note: "Withdraw before exitBy (2 h before the NYSE reopens). Spot only; River does not hold your funds.",
  };
}

async function agentView(env: Env) {
  const wallet = env.AGENT_WALLET?.toLowerCase() ?? null;
  const [treasury, cycles, bnb, usdt] = await Promise.all([
    env.RIVER_KV.get<Treasury>(TREASURY_KEY, "json"),
    env.RIVER_KV.get<unknown[]>(PUBLIC_CYCLES_KEY, "json"),
    wallet ? rpc<string>("eth_getBalance", [wallet, "latest"], { url: env.BSC_RPC_URL }).then((h) => Number(BigInt(h) / 10n ** 12n) / 1e6).catch(() => null) : null,
    wallet ? erc20Balance(USDT, wallet, { url: env.BSC_RPC_URL }).catch(() => null) : null,
  ]);
  const agentId = env.AGENT_ID ? Number(env.AGENT_ID) : null;
  return {
    identity: { standard: "ERC-8004", registry: `eip155:${ERC8004.chainId}:${ERC8004.identity}`, agentId, owner: wallet,
      scan: agentId !== null ? `https://www.8004scan.io/agents/bsc/${agentId}` : null, registration: "https://api.rivrwa.com/.well-known/agent-registration.json" },
    wallet: wallet ? { address: wallet, bnb, usdt } : null,
    pricing: { planUsd: PLAN_PRICE_USD, rails: ["b402 (x402 v2, Binance facilitator)", "USDT transfer + tx hash"] },
    treasury: treasury ?? { paidCalls: 0, revenueUsd: 0, byRail: {}, recent: [] },
    cycles: cycles ?? [],
  };
}

const MCP_INSTRUCTIONS =
  "River runs tokenized-stock (bStocks) liquidity on PancakeSwap v3 only while the NYSE is closed. Free tools: get_weekend_window (the market clock), " +
  "list_assets, get_range (the IVL band for the next window) and get_cycle_report (River's executed cycles, with tx hashes). plan_cycle is paid " +
  "(x402, $0.10): call it once to get the payment requirements, pay from your own wallet (b402 signature, or a USDT transfer), then call again with " +
  "payment_signature or payment_tx. River never holds your keys.";

function mcpTools(env: Env, registry: RegistryAsset[], url: URL): McpTool[] {
  const sym = { type: "string", description: "Stock token symbol, e.g. NVDAB" };
  return [
    { name: "get_weekend_window", description: "The NYSE closed window River trades in: current phase, the window, entry (+1 h) and exit (−2 h) times, and the next windows.",
      inputSchema: { type: "object", properties: {} },
      run: async () => { const now = Date.now(); return { ...clockState(now), upcoming: closedWindowsBetween(now - 4 * 86400e3, now + 30 * 86400e3).filter((w) => w.end > now).slice(0, 4) }; } },
    { name: "list_assets", description: "Tokenized stocks River runs (enabled) or watches, with pool, fee tier and the latest automatic Gate 0 review.",
      inputSchema: { type: "object", properties: {} },
      run: async () => ({ assets: registry.map((a) => ({ symbol: a.symbol, underlying: a.underlying, enabled: a.enabled, pool: a.pool, feeTier: a.feeTier, note: a.note ?? null })) }) },
    { name: "get_range", description: "Where River would place liquidity for the next closed window: IVL μ±2σ band (fraction of price), current price, entry and exit times.",
      inputSchema: { type: "object", properties: { symbol: sym }, required: ["symbol"] },
      run: async (a) => {
        const asset = resolveAsset(registry, String(a.symbol ?? "")) as RegistryAsset | undefined;
        if (!asset?.enabled) throw new InvalidParams(`${String(a.symbol)} is not an enabled asset`);
        const s = await cachedSignal(env, asset);
        return { symbol: asset.symbol, price: s.price, band: s.band, ivl: s.ivl, entryAt: new Date(s.entryAt).toISOString(), exitAt: new Date(s.exitAt).toISOString() };
      } },
    { name: "get_cycle_report", description: "River's executed cycles (newest first): entry/exit, deposited and withdrawn amounts, fees, gas and the BSC tx hashes. Also the backtest summary.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      run: async (a) => ({ cycles: ((await env.RIVER_KV.get<unknown[]>(PUBLIC_CYCLES_KEY, "json")) ?? []).slice(0, Math.min(50, Number(a.limit) || 10)), backtest: BACKTEST }) },
    { name: "plan_cycle", description: `Paid (x402, $${PLAN_PRICE_USD.toFixed(2)}). A cycle plan fitted to YOUR inventory: action now, the band snapped to pool ticks, the no-swap deposit and the exact Binance lp-add arguments. Call without payment to get the requirements.`,
      inputSchema: { type: "object", properties: {
        symbol: sym, stock: { type: "number", description: "Stock tokens you hold" }, usd: { type: "number", description: "USDT you hold" },
        maxHalfWidth: { type: "number", description: "Cap on the band half-width, default 0.05" },
        payment_signature: { type: "string", description: "base64 x402 v2 PaymentPayload (b402)" }, payment_tx: { type: "string", description: "Hash of your USDT transfer to payTo" },
      }, required: ["symbol", "stock", "usd"] },
      run: async (a) => {
        const plan = await fittedPlan(env, registry, a); // validate before charging
        const c = await charge(env, `${url.origin}/mcp#plan_cycle`, { signature: a.payment_signature as string | undefined, tx: a.payment_tx as string | undefined });
        if (!c.ok) throw new PaymentRequired(c.challenge);
        return { ...plan, payment: { rail: c.rail, payer: c.payer, tx: c.tx } };
      } },
  ];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (!(await underRateLimit(req))) return json(env, { error: "rate_limited" }, 429);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (path === "/v1/health") return json(env, { ok: true, service: "rivrwa-api", now: new Date().toISOString() });

      if (path === "/v1/clock") {
        const now = Date.now();
        const upcoming = closedWindowsBetween(now - 4 * 86400e3, now + 60 * 86400e3).filter((w) => w.end > now).slice(0, 8);
        return json(env, { ...clockState(now), upcoming }, 200, 60);
      }

      const registry = await loadRegistry(env);

      if (path === "/v1/assets") {
        let live: Record<string, unknown> = {};
        if (env.BINANCE_WEB3_API_KEY && env.BINANCE_WEB3_SECRET_KEY) {
          const bw = binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY }, egressFetch(env.BAW));
          const toks = (await Promise.all(ISSUERS.map(([p]) => bw.rwaTokens(p).catch(() => [])))).flat();
          live = Object.fromEntries(toks.map((t) => [t.tokenContractAddress.toLowerCase(), {
            price: +t.tokenPrice, referencePrice: +t.referencePrice, tokenToShareRatio: +t.tokenToShareRatio, status: t.statusInfo,
          }]));
        }
        return json(env, { fee: RIVER_FEE, assets: registry.map((a) => ({ ...a, live: live[a.token] ?? null })) }, 200, 60);
      }

      if (path === "/v1/stocks") return json(env, await cachedCatalog(env), 200, 300);

      if (path === "/v1/signals") {
        const out = [];
        for (const a of registry.filter((x) => x.enabled)) {
          const signal = await cachedSignal(env, a).catch(() => null);
          if (signal) out.push({ symbol: a.symbol, signal });
        }
        return json(env, out, 200, 60);
      }

      const m = path.match(/^\/v1\/(signal|gate)\/([A-Za-z0-9.]+)$/);
      if (m) {
        const a = resolveAsset(registry, m[2]) as RegistryAsset | undefined;
        if (!a) return json(env, { error: "unknown_asset" }, 404);
        if (m[1] === "gate") return json(env, { symbol: a.symbol, enabled: a.enabled, source: a.source, failStreak: a.failStreak, gate: a.gate ?? null, note: a.note ?? null }, 200, 300);
        if (!a.enabled) return json(env, { error: "asset_disabled", note: a.note }, 409);
        return json(env, { symbol: a.symbol, signal: await cachedSignal(env, a) }, 200, 60);
      }

      if (path === "/v1/simulate") {
        const a = resolveAsset(registry, url.searchParams.get("symbol") ?? "") as RegistryAsset | undefined;
        if (!a) return json(env, { error: "unknown_asset" }, 404);
        if (!a.enabled) return json(env, { error: "asset_disabled" }, 409);
        // One significant figure between $100 and $1M, so results cache well.
        const raw = Math.min(1e6, Math.max(100, Number(url.searchParams.get("size")) || 10_000));
        const mag = 10 ** Math.floor(Math.log10(raw));
        const size = Math.round(raw / mag) * mag;
        const show = ([1, 2, 4].includes(Number(url.searchParams.get("x"))) ? Number(url.searchParams.get("x")) : 1) as 1 | 2 | 4;
        const cacheKey = new Request(`${url.origin}/__sim/${a.token}/${size}/${show}`);
        const hit = await caches.default.match(cacheKey);
        if (hit) return json(env, await hit.json(), 200, 600);
        const inputs = await env.RIVER_KV.get<GateInputs>(inputsKey(a.token), "json");
        if (!inputs) return json(env, { error: "not_reviewed_yet" }, 409);
        const body = { symbol: a.symbol, reviewedAt: inputs.at, ...simulate(a, candlesOf(inputs), inputs.snapshot, size, show) };
        await caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { "cache-control": "max-age=3600" } }));
        return json(env, body, 200, 600);
      }

      if (path === "/v1/discover" && req.method === "POST") {
        if (!env.ADMIN_KEY || req.headers.get("x-admin-key") !== env.ADMIN_KEY) return json(env, { error: "unauthorized" }, 401);
        const token = url.searchParams.get("token")?.toLowerCase();
        if (!token) return json(env, await discoverStep(env, () => catalogTokens(env)));
        const c = (await catalogTokens(env)).find((x) => x.token === token);
        if (!c) return json(env, { error: "token not in the catalog" }, 404);
        return json(env, await discoverToken(env, c));
      }

      if (path === "/v1/plan" && req.method === "POST") {
        const b = (await req.json()) as { mandate: Mandate; inventory: { stock: number; usd: number }; position?: OpenPosition | null; events?: number[] };
        const a = resolveAsset(registry, b.mandate?.asset ?? "") as RegistryAsset | undefined;
        if (!a) return json(env, { error: "unknown_asset" }, 400);
        const signal = await cachedSignal(env, a);
        const action = planCycle({ now: Date.now(), asset: a, signal, mandate: b.mandate, inventory: b.inventory, position: b.position ?? null, events: b.events });
        return json(env, { action, signal: { price: signal.price, band: signal.band, entryAt: signal.entryAt, exitAt: signal.exitAt } });
      }

      if (path === "/v1/backtest") return json(env, BACKTEST, 200, 3600);

      if (path === "/.well-known/agent-registration.json")
        return json(env, agentRegistration({ agentId: env.AGENT_ID ? Number(env.AGENT_ID) : null, web: "https://rivrwa.com", api: "https://api.rivrwa.com", image: "https://rivrwa.com/favicon.svg" }), 200, 300);

      if (path === "/v1/agent") return json(env, await agentView(env), 200, 30);

      if (path === "/mcp") return handleMcp(req, mcpTools(env, registry, url), cors(env), MCP_INSTRUCTIONS);

      if (path === "/v1/paid/plan") {
        const q = Object.fromEntries(url.searchParams);
        let plan;
        try { plan = await fittedPlan(env, registry, q); } catch (e) {
          if (e instanceof InvalidParams) return json(env, { error: "invalid_params", detail: e.message }, 400);
          throw e;
        }
        const resource = `${url.origin}/v1/paid/plan`;
        const proof: Proof = { signature: req.headers.get(HEADERS.signature), tx: req.headers.get(HEADERS.tx) };
        const c = await charge(env, resource, proof);
        if (!c.ok) return new Response(JSON.stringify(c.challenge), { status: c.status, headers: { "content-type": "application/json", [HEADERS.required]: encodeHeader(c.challenge), ...cors(env) } });
        const receipt = { success: true, transaction: c.tx, network: "eip155:56", payer: c.payer, rail: c.rail };
        return new Response(JSON.stringify(plan), { headers: { "content-type": "application/json", "cache-control": "no-store", [HEADERS.response]: encodeHeader(receipt), ...cors(env) } });
      }

      return json(env, { error: "not_found" }, 404);
    } catch (e) {
      return json(env, { error: "upstream_error", detail: (e as Error).message }, 502);
    }
  },

  async scheduled(c: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (c.cron === DISCOVERY_CRON) {
      ctx.waitUntil(discoverStep(env, () => catalogTokens(env)).then((r) => console.log(`discovery: reviewed ${r.reviewed.join(", ") || "none"}, ${r.queued} queued`)));
    } else ctx.waitUntil(refreshAll(env));
  },
};
