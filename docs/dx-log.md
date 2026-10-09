# DX log — raw facts for the Developer Experience Report

The DX report must be written by a human; AI-generated reports are rejected. This file is only a dated log of
observed facts to write it from: what happened, the evidence, and the doc page involved.

## 2026-09-28

**Auth / onboarding**
- Signing is HMAC-SHA256 over `timestamp + METHOD + requestPath + body`, sent in the `X-OC-*` headers.
  - The `/build` prefix must be part of the signed path.
  - The per-product reference page (RWA Data) only links to the Authentication page and does not state the algorithm.
  - Source: dev-docs/authentication.
- The first signed call worked on the first try once the `/build` detail was known.

**RWA Data API**
- `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock` works.
- NVDAB returned `statusInfo.marketStatus`, `nextOpenTime` and `nextCloseTime` all as **null**, with `reasonCode: TRADING`.
  - The docs advertise these fields for market-hours logic.
  - As a result we must build our own NYSE clock.
- `tokenToShareRatio` for NVDAB is 1.000778 (the dividend multiplier). Useful, and it needs explaining in the UI.
- An earlier finding (research agent, same day): `platformId` only accepts `ondo` and `bstock`, so **xStocks is not covered**.

**DeFi API**
- `investment/list` with `investType: LiquidityPool` and a `tokenAddressList` filter returns the NVDAB/USDT pools:
  - PancakeSwap v3 0.25%: `investmentId 9c97dee1…`, `poolAddress 0x8fb4…690c`, `investable: true`, APR 82.54%.
- `lp-add/calculate` accepts custom `tickLower`/`tickUpper`, returns the paired amount plus `poolInfo.currentTick`, and works for any address.
- `lp-add` with `simulate: true` on an address without balance returns **code 40484 "Insufficient balance"** inside an HTTP 200.
  - So simulation requires a funded address.
  - It cannot be used to preview a position for a prospective user before they fund.
- `lp-add` with `simulate: false` accepts a **contract address** as `address`, which we need for smart-account (Altana) flows.
  - It returns: APPROVE NVDAB, APPROVE USDT, then `NonfungiblePositionManager.mint` (`0x46A1…4364`, selector `0x88316456`) with `recipient = address`.
- ⚠️ **The approvals are unlimited** (`MaxUint256`) toward the NPM. A per-amount option would be safer.
- ⚠️ `slippageBps: "50"` produced `amount0Min` 0.806 vs 1.0 desired (−19%) and `amount1Min` 80.88 vs 125.5 needed (−35%).
  - That protection is much looser than the 0.5% requested.
  - It needs clarification in the docs, or it is a bug.
- The gas price quoted was 0.055 gwei, so a full LP cycle costs about cents. Our backtest had assumed $0.60.

**Altana (smart account, flow B)**
- SDK 0.9.0 supports BSC mainnet (chainId 56).
- Session permissions are `{to, signature}` call scopes + spend caps + expiry. There is **no argument-level constraint**, so
  `mint` and `collect` with an arbitrary `recipient` cannot be blocked.
  - Mitigation on our side: the account holds only the allocated amount, the session is window-length, no `multicall` and no `approve` in the session.
  - Feature request for Altana: argument-level constraints.

## 2026-09-29

**Agentic Wallet (`baw` CLI 1.10, flow A), from the docs while building the runner. Not yet run live.**
- `defi lp-add` returns only `{txHash}`, with no position NFT id.
  - The id must be parsed from the mint receipt (NPM `Transfer` from 0x0).
  - `defi position` lags the chain, so it is not a substitute.
- A txHash means "submitted": the caller has to poll a BSC RPC for the receipt.
- `lp-add` takes one token + amount and derives the other leg from the pool's live tick.
  - The skill says the wallet does not swap, so the user must already hold both legs.
- The session is capped at `maxSigninDuration` (48h in the docs) plus a 48h inactivity sign-out.
  - The session is stored per machine (`~/.baw`, encrypted with a machine key), so the agent must run where sign-in happened.
  - A normal weekend (45h active) fits. A holiday weekend (72h) does not fit in one session.
- `abnormalTxnHandling=NeedConfirmation` makes a flagged tx wait for approval in the App.
  - An unattended agent should use `AutoReject`.
- `lp-add` and `lp-remove` take no `--binanceChainId`, while `claim` and `preview` do.
- Error envelope: `{"success":false,"error":{code,name,message}}` with exit code 1. It is consistent, which makes the CLI easy to script.

**Agentic Wallet, tested live (2026-09-29, `baw` 1.10.0 in a Debian container without libsecret).**
- `@github/keytar` fails to load without libsecret. `baw` then stores the whole session in `$BINANCE_BAW_DIR/session.json` (223 bytes).
- Copying that file into a **new** container (different hostname/MAC) with the same `BINANCE_INSTANCE_ID` stays `CONNECTED`.
  - With a different `BINANCE_INSTANCE_ID` it reads as `UNCONNECTED`, so the ID acts as the file's key.
  - This is what lets a hosted agent keep one session per user.
- On macOS the session id goes to a single keychain entry (`baw`/`agentSessionId`) no matter what `BINANCE_BAW_DIR` is, so one Mac can hold only one user's session.
- `wallet settings` after sign-in:
  - `maxSigninDuration: "48h"`;
  - `signInMaxTime` = sign-in + **7 days**;
  - `inactiveSignOutTime` = last command + 48h.
  - A later command moved `inactiveSignOutTime` forward: **activity extends the session, up to the 7-day cap**.
  - The docs describe `maxSigninDuration` as the max sign-in time. The observed hard cap (7d) and the displayed value (48h) do not match; this needs clarification.
- The Agentic Wallet has its own EVM address (the same on BSC/ETH/Base/Arbitrum/Polygon), separate from the user's other wallets.
- The sign-in `urlForWeb` came back as an `app.binance.com/uni-qr/...` short link, not the `web3.binance.com/en/agent-login` URL shown in the docs.

**Hosting on Cloudflare (2026-09-29).**
- From a deployed Worker, every Binance Web3 API call (`rwa/tokens`) answered `Service not available due to compliance restriction`.
  - It still failed with the Worker pinned to Paris (`placement = targeted, aws:eu-west-3`; the response carried `cf-placement: remote-CDG`). So the block is not about the colo's country; it seems to target Workers' shared egress.
  - The same call from a Cloudflare Container (`baw` image) and from a residential connection worked.
  - The error names no country and no rule, so a developer cannot tell a geo block from an IP-reputation block.
- `baw auth signin` from the Container got a pairing code in ~3.5 s (warm).
- The RWA Data catalog for BSC listed 488 tokens: `platformId=bstock` and `platformId=ondo` together, ETFs included.
- GeckoTerminal's free API answered 429 to the Worker on every try, but not to the Container.

**DeFi `investment/list` for discovery (2026-09-29).**
- `tokenAddressList` takes many tokens: 40 bStock addresses in one call returned all 38 of their pools, across protocols (`pancakeswap3`, `uniswap3`, `uniswap4`, `pancakeswap4`).
- `size: 200` returns `Parameter error`, and so does any size above 100; pages go through `page`.
- The list items carry no pool address and no token addresses, only `investmentName` ("NVDAB-USDT", "USDT-SPCXB"). The pool comes from `investment/detail` (`poolAddress`, `feeRate` as "0.0025", `assetTokenList`).
- Across the 488 catalog tokens, 20 have a PancakeSwap v3 pool against USDT with TVL ≥ $50k.
- `bsc-rpc.publicnode.com` answered HTTP 429 to JSON-RPC batches from a deployed Worker, but not from the container. `bsc-dataseed.bnbchain.org` rate-limits 50-call batches even from a residential connection.

**lp-add calldata, re-checked (2026-09-30).**
- For an `address` that holds nothing, `lp-add` (simulate false) still built `[APPROVE stock, APPROVE USDT, mint]`; both approvals are unlimited (`2^256-1`) to the NPM.
- `lp-add/calculate` rejects equal ticks ("tickLower must be less than tickUpper") even though it is only used to read `poolInfo.currentTick`; a full-range pair works.
- The mint's `amount0Min/amount1Min` with `slippageBps: 50` were ~0.67 NVDAB and ~199 USDT for 1 NVDAB + 250 USDT desired, i.e. relative to the amounts the mint will actually use at the current tick, not to the desired ones. A client that recomputes mins as `desired × (1 − slippage)` gets a mint that reverts.
- The mint deadline was ~1.5 h after the request.

**Altana SDK 0.9.0 on BSC mainnet (2026-09-30).**
- The SDK (viem + Porto + ox) bundles into a Worker (~1.8 MB, 346 KB gzip) and loads in workerd; `createPrivateKeySigner` works there.
- `grantSession` reads only `address` and `publicKey` from `sessionSigner` (key descriptor and key hash); a signer whose `signDigest` throws is enough, so the session's private key can stay on a server that never touches the passkey.
- Before an account's first intent there is no code at its address, so `getKeys()` reverts (`execution reverted: 0x`) rather than returning an empty list.
- In `getKeys()`, a secp256k1 key's `publicKey` is the left-padded address and a passkey's is the P-256 x ‖ y; matching by public key needs no SDK internals.
- `balances()` returns raw `balanceOf` plus a display value scaled by BEP-677's UI multiplier when a token implements it; transfers must use the raw value.
- The SDK's reads go to `bsc-rpc.publicnode.com` (hard-coded in the `BNB` config, overridable by passing a copy of the config with another `publicRpcUrl`).
- The docs do not say whether a session with spend caps can move a token that has no cap, or whether a pull by `transferFrom` (the NPM's mint) counts against a cap. River sets caps for the stock, USDT and BNB. To verify with the first small grant.


**Transaction, Market and b402 APIs, first calls (2026-10-06).**
- The human-readable dev-docs (`web3.binance.com/en/dev-docs/...`) answered HTTP 202 with a bot challenge to curl and to a fetch tool. Endpoint paths and shapes were read from the generated SDK instead (`github.com/binance/binance-web3-connector-js`, `clients/web3-wallet/src/rest-api/modules/*.ts`).
- `POST /api/v1/dex/pre-transaction/simulate` (`{binanceChainId:"56", evmTx:{from,to,value,data}}`) simulated a USDT `transfer` from an arbitrary address. It returned `status:"SUCCESS"`, `balanceChanges` (signed integer `change`, lowercase `owner`) and `allowanceChanges`. No gas line appeared among the balance changes.
- `GET /api/v1/dex/pre-transaction/gas-price?binanceChainId=56` returned only `evmLegacyGasPrice` (low/medium/high, in wei). `eip1559GasPrice` was null on BSC.
- `GET /api/v1/dex/market/candles` (1h, NVDAB) returns rows `[open, high, low, close, volume, tsMs, trades]`, oldest first. The timestamp is in **ms** and sits in position 6, unlike GeckoTerminal (seconds, first).
  - `limit=300` works; 500 and 1000 return `40001 invalid limit range`.
  - `after=<ms>` pages back to older candles. `before=<ms>` returned the same newest page, i.e. it did not page.
- Candles are per token (across venues), not per pool. River's signal computed from them gave a narrower band than from the pool's GeckoTerminal candles: NVDAB ±0.96% vs ±1.33%, TSLAB ±0.79% vs ±1.03% (same 4 windows, same code).
- `POST /api/v1/dex/market/price` with `[{binanceChainId, tokenContractAddress}]` returned `{price, time}`.
- `GET /api/v1/dex/market/rwa/underlying-market` for NVDAB at 17:30 UTC on a Tuesday returned `statusInfo.openState:true`, `reasonCode:"TRADING"`, and `marketStatus`, `nextOpenTime`, `nextCloseTime` all null. It also returned market data (market cap, P/E, 52-week range, dividend).
- `POST /api/v2/b402/supported` with River's key returned `40104 No permission: B402`. The key needs the "B402 Payments" permission in the Developer Portal; the error names the permission but not where to grant it.
- b402's success code is `"000000"`, while every other module returns `0`. A client that checks `code === 0` treats a successful b402 call as an error.
- The SDK wraps b402 bodies one level deeper (`{"body": {...}}`) than every other POST in the API.
- Binance's own b402 demo seller (`bnb-chain/stockanalyst-agent-demo`) calls `/papi/v2/b402/*` with `X-Tesla-*` headers and an RSA key, not `/build/api/v2/b402/*` with `X-OC-*`. That gives two documented hosts for the same facilitator.

**ERC-8004 on BSC mainnet (2026-10-06).**
- IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is an EIP-1967 proxy (`name()` "AgentIdentity", `symbol()` "AGENT"). The implementation at `0x7274e874…9c02` contains `register(string)`, `register()`, `setAgentURI(uint256,string)` and `setAgentWallet(uint256,address,uint256,bytes)`.
- ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` has code on BSC.

**x402 sale and ERC-8004 registration, live (2026-10-07).**
- `register(string)` from an EOA minted ERC-8004 agent id 365864 on BSC mainnet (tx `0x9e91a4d4…9dad`), and `tokenURI(365864)` returned the HTTPS agentURI as sent. A wallet that already owned one agent id (IVL's) could mint a second one.
- `tokenOfOwnerByIndex` reverts on the registry, so an owner's ids cannot be listed on-chain. Public BSC RPCs refused the historical `eth_getLogs` needed to find them: publicnode answered "Archive requests require a personal token", bnbchain dataseed "limit exceeded".
- The first paid plan was 0.10 USDT sent as a plain transfer from a browser wallet (tx `0x1bfe700b…5a11`). It confirmed in under 10 s; River's API answered 200 with the plan and `PAYMENT-RESPONSE`, and 409 when the same hash came back.
