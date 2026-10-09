// binance.ts — Binance Web3 API client (RWA Data, Market, DeFi, Transaction, b402). WebCrypto only, so the same
// code runs in Node 24 and Cloudflare Workers.
//
// What River uses each module for: RWA Data lists the tokenized stocks; DeFi finds each stock's PancakeSwap pool
// and builds lp-add / lp-remove; Market's candles back GeckoTerminal up for the signal; Transaction's `simulate`
// dry-runs every call before River signs it (simguard.ts); b402 settles the x402 payments other agents make for
// River's plan (x402.ts).
//
// Auth: X-OC-APIKEY / X-OC-TIMESTAMP / X-OC-SIGN, where the signature is
// Base64(HMAC-SHA256(timestamp + METHOD + requestPath + body, secret)) and requestPath MUST
// include the `/build` prefix plus the raw query string (dev-docs/authentication).

import type { Candle } from "./geckoterminal.ts";

const BASE = "https://web3.binance.com";
const PREFIX = "/build";

export interface BinanceKeys {
  apiKey: string;
  secretKey: string;
}

export interface BwResponse<T> {
  code: number | string;
  msg?: string;
  data: T;
  success?: boolean;
}

export class BinanceWeb3Error extends Error {
  readonly code: string | number;
  constructor(code: string | number, message: string) {
    super(message);
    this.code = code;
  }
}

async function hmacBase64(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function binanceWeb3(keys: BinanceKeys, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    const requestPath = PREFIX + path + qs;
    const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const ts = new Date().toISOString();
    const r = await fetchImpl(BASE + requestPath, {
      method,
      body: body || undefined,
      headers: {
        "X-OC-APIKEY": keys.apiKey,
        "X-OC-TIMESTAMP": ts,
        "X-OC-SIGN": await hmacBase64(keys.secretKey, ts + method + requestPath + body),
        "content-type": "application/json",
      },
    });
    const j = (await r.json()) as BwResponse<T>;
    // Errors arrive as HTTP 200 with a non-zero code (e.g. 40484 insufficient balance). b402 says "000000" for success.
    if (!r.ok || !["0", "000000"].includes(String(j.code))) throw new BinanceWeb3Error(j.code ?? r.status, j.msg ?? `HTTP ${r.status}`);
    return j.data;
  }

  return {
    call,
    /** RWA token list for an issuer (`bstock` | `ondo`) on BSC. */
    rwaTokens: (platformId: "bstock" | "ondo") =>
      call<RwaToken[]>("GET", "/api/v1/dex/market/rwa/tokens", { query: { binanceChainId: "56", platformId } }),
    /** DeFi pools holding any of the tokens, one page (`size` ≤ 100, larger is a "Parameter error"). */
    investmentList: (tokenAddressList: string[], page = 1, size = 100) =>
      call<{ page: number; size: number; total: number; list: InvestmentListItem[] }>("POST", "/api/v1/defi/data/investment/list", {
        body: { investType: "LiquidityPool", tokenAddressList, binanceChainId: "56", sortField: "tvl", sortDirection: "DESC", page, size },
      }),
    investmentDetail: (investmentId: string) =>
      call<InvestmentDetail>("POST", "/api/v1/defi/data/investment/detail", { body: { investmentId } }),
    positions: (addresses: string[]) =>
      call<unknown>("POST", "/api/v1/defi/data/position/list", { body: { addresses, binanceChainIds: ["56"] } }),
    /** Paired amount for a band (works for any address, no balance needed). */
    lpAddCalculate: (b: { address: string; investmentId: string; inputToken: { tokenAddress: string; amount: string }; tickLower: string; tickUpper: string }) =>
      call<{ outputs: { tokenAddress: string; tokenSymbol: string; amount: string }[]; poolInfo: { currentTick: string } }>("POST", "/api/v1/defi/transaction/lp-add/calculate", { body: b }),
    /** Unsigned calldata: [APPROVE…, LP_ADD]. Executors sign; this never moves funds. */
    lpAdd: (b: { address: string; investmentId: string; tokenList: { tokenAddress: string; amount: string }[]; tickLower: string; tickUpper: string; slippageBps?: string; simulate?: boolean }) =>
      call<{ dataList: TxRequest[]; preview?: unknown }>("POST", "/api/v1/defi/transaction/lp-add", { body: b }),
    lpRemove: (b: { address: string; investmentId: string; nftId: string; ratio: string; slippageBps?: string; simulate?: boolean }) =>
      call<{ dataList: TxRequest[]; preview?: unknown }>("POST", "/api/v1/defi/transaction/lp-remove", { body: b }),
    /** Dry-run of any unsigned tx from any address: status plus every balance and allowance it would change. */
    simulate: (tx: { from: string; to: string; data: string; value?: string }) =>
      call<SimulateResult>("POST", "/api/v1/dex/pre-transaction/simulate", { body: { binanceChainId: "56", evmTx: { ...tx, value: tx.value ?? "0" } } }),
    gasLimit: (tx: { from: string; to: string; data: string; value?: string }) =>
      call<{ gasLimit: string }>("POST", "/api/v1/dex/pre-transaction/gas-limit", { body: { binanceChainId: "56", evmTx: { ...tx, value: tx.value ?? "0" } } }),
    gasPrice: () =>
      call<{ evmLegacyGasPrice: { lowGasPrice: string; mediumGasPrice: string; highGasPrice: string } | null }>("GET", "/api/v1/dex/pre-transaction/gas-price", { query: { binanceChainId: "56" } }),
    /** Token candles, oldest first: [open, high, low, close, volume, tsMs, trades]. `limit` ≤ 300 (more is "invalid limit
     *  range"); `after` (ms, exclusive) pages back to older candles, while `before` is ignored for paging. */
    candles: (token: string, o: { bar?: "1h" | "15m" | "1d"; limit?: number; after?: number } = {}) =>
      call<[number, number, number, number, number, number, number][]>("GET", "/api/v1/dex/market/candles", {
        query: { binanceChainId: "56", tokenContractAddress: token, bar: o.bar ?? "1h", limit: String(Math.min(300, o.limit ?? 300)), ...(o.after ? { after: String(o.after) } : {}) },
      }),
    prices: (tokens: string[]) =>
      call<{ tokenContractAddress: string; price: string; time: number }[]>("POST", "/api/v1/dex/market/price", { body: tokens.map((t) => ({ binanceChainId: "56", tokenContractAddress: t })) }),
    /** b402 (x402 v2 with Binance as facilitator). The key needs the "B402 Payments" permission, else 40104. */
    b402Supported: () => call<{ kinds: B402Kind[] }>("POST", "/api/v2/b402/supported", { body: { body: {} } }),
    b402Verify: (paymentPayload: unknown, paymentRequirements: unknown) =>
      call<{ isValid: boolean; payer?: string | null; invalidReason?: string | null }>("POST", "/api/v2/b402/verify", { body: { body: { x402Version: 2, paymentPayload, paymentRequirements } } }),
    /** Moves the payer's funds: irreversible. A failed settlement is `success: false` inside a success envelope. */
    b402Settle: (paymentPayload: unknown, paymentRequirements: unknown) =>
      call<{ success: boolean; transaction: string; payer?: string | null; network: string; amount?: string; errorReason?: string | null }>("POST", "/api/v2/b402/settle", { body: { body: { x402Version: 2, paymentPayload, paymentRequirements } } }),
  };
}

export type BinanceWeb3 = ReturnType<typeof binanceWeb3>;

/** Hourly candles from Binance Market, as GeckoTerminal-shaped `Candle`s (ts in seconds), oldest first. These are
 *  the token's candles across venues, not one pool's, so they back GeckoTerminal up rather than replace it. */
export async function fetchBinanceHistory(bw: Pick<BinanceWeb3, "candles">, token: string, pages = 4): Promise<Candle[]> {
  const byTs = new Map<number, Candle>();
  let after: number | undefined;
  for (let i = 0; i < pages; i++) {
    const rows = await bw.candles(token, { bar: "1h", limit: 300, after });
    for (const [o, h, l, c, vol, ms] of rows) byTs.set(Math.floor(ms / 1000), { ts: Math.floor(ms / 1000), o: +o, h: +h, l: +l, c: +c, vol: +vol });
    if (rows.length < 300) break;
    after = rows[0][5];
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export interface SimulateResult {
  status: "SUCCESS" | "FAILED" | string;
  failReason: string | null;
  /** `change` is a signed integer string in the token's base units; `owner` is lowercase. */
  balanceChanges: { contractAddress: string; tokenType: string; change: string; owner: string }[];
  allowanceChanges: { tokenAddress: string; owner: string; spender: string; preAmount: string; postAmount: string }[];
}

export interface B402Kind {
  x402Version: number;
  scheme: "exact" | "upto";
  network: string;
  extra: { name: string; version: string; assetTransferMethod: "eip3009" | "permit2-exact" | "permit2-upto"; signerAddress: string; spenderAddress?: string | null };
}

export interface RwaToken {
  tokenContractAddress: string;
  tokenSymbol: string;
  tokenLogoUrl?: string;
  decimals?: number;
  underlyingTicker: string;
  assetType: number;
  tokenToShareRatio: string;
  tokenPrice: string;
  referencePrice: string;
  statusInfo: { openState: boolean; marketStatus: string | null; reasonCode: string; reasonMsg: string | null; nextOpenTime: number | null; nextCloseTime: number | null };
}

export interface InvestmentListItem {
  defiProtocolId: string;
  protocolName: string;
  investmentId: string;
  /** Pair as "TOKEN0-TOKEN1" symbols, e.g. "NVDAB-USDT" or "USDT-SPCXB". */
  investmentName: string;
  apyDisplay: string;
  tvl: string;
}

export interface InvestmentDetail {
  investmentId: string;
  investmentName: string;
  investable: boolean;
  apyDisplay: string;
  tvl: string;
  poolAddress: string;
  /** Fraction as a string, e.g. "0.0025". */
  feeRate: string;
  assetTokenList?: { tokenAddress: string; tokenSymbol: string }[];
}

export interface TxRequest {
  callDataType: "APPROVE" | "LP_ADD" | "LP_REMOVE" | "CLAIM" | string;
  from: string;
  to: string;
  value: string;
  data: string;
  gasLimit?: string;
  gasPrice?: string;
}
