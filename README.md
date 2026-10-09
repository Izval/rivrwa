# River — rivrwa.com

Live: **https://rivrwa.com** · public API **https://api.rivrwa.com** (`/v1/health`, `/v1/signals`, `/v1/backtest`).

**Liquidity that flows into real-world assets.** River's first stream: your tokenized stocks (bStocks) provide
concentrated liquidity on PancakeSwap v3 **only while Wall Street is closed**, then flow back before the reopen.
You end up with the same shares plus the fees. River is non-custodial: there is no vault and no River contract
holding funds. An agent executes the mandate you set, from your own wallet.

- **Why it works.** DeFi runs 24/7 and the NYSE does not. While the market is closed, the on-chain price is
  anchored to the last close and moves sideways, yet weekend flow keeps paying fees. Research: `research/gate0/`
  (production replay: NVDAB ~68% net APR base case, ~10% under 4× competing liquidity). The same LP on weekdays loses.
- **Where the band goes.** IVL (Internal Variance of Lateralization) measures how price oscillates inside past
  closed windows, and River deploys μ±2σ. That lifted net APR by 41–81% across scenarios (`research/ivl-study/`).
- **River's fee.** 5% of the LP fees earned + $0.25 per cycle.
- **Two ways to connect:**
  - **A. Binance Agentic Wallet**, approved in the Binance App as a weekend pass.
  - **B. River-native**, with any EVM wallet and an Altana smart account holding a scoped session key issued from the River UI.

## For judges
**Try it in two minutes.**
- Open **https://rivrwa.com**: the tide gauge shows the next NYSE closed window, when River would enter and leave, and
  counts down to it. Below it are the replayed backtest, a simulator over every past weekend for each stock River runs,
  and the live catalog of every tokenized stock on BSC.
- Ask the agent: `curl -i "https://api.rivrwa.com/v1/paid/plan?symbol=NVDAB&stock=1&usd=250"` answers `402` with its
  x402 payment requirements. Or add `https://api.rivrwa.com/mcp` to any MCP client (5 tools).
- Free endpoints: `https://api.rivrwa.com/v1/clock`, `/v1/signals`, `/v1/backtest`, `/v1/stocks`.

**Where each criterion lives.**
| Criterion | Where to look |
|---|---|
| Technical implementation | `packages/core`: a pure planner (`planner.ts`) over a local NYSE clock (`clock.ts`) and v3 math that fits the band to the wallet's own token ratio, so nothing is swapped (`v3.ts`). Two non-custodial signing paths: flow A drives the Binance Agentic Wallet from a Cloudflare container (`agent/src/agentic-wallet.ts`, `containers/baw`); flow B holds a scoped Altana session key sealed server-side (`workers/agent/src/altana*.ts`). Before River signs, `npm.ts` checks the calldata and Binance's `simulate` dry-runs it (`simguard.ts`). A daily discovery cron replays every tokenized stock's pool and switches stocks on by rule (`workers/api/src/discover.ts`, `gate.ts`). 80 tests (`npm test`). |
| Creativity and originality | The edge is the market clock: liquidity only while the NYSE is closed, when price drifts sideways and weekend flow still pays fees; the same position on weekdays loses (`research/gate0`). The band is measured with IVL on past closed windows (`research/ivl-study`). The model is generic (`Asset + Clock + Venue + Mandate`), so other real-world assets with a clock can follow. River is also an agent that sells its own plan. |
| Developer Experience Report | Submitted through the organisers' form. The dated raw facts behind it are in `docs/dx-log.md`. |
| Product quality and UX | rivrwa.com: Binance pairing with a QR, the Altana wizard (create, fund, grant for 1, 3 or 6 months), mandate presets, and a dashboard with a readiness checklist, a rehearsal of the next entry, "Leave the pool now", revoke and withdraw. |
| Special: Agentic Wallet | Flow A: River signs from the user's own Binance Agentic Wallet under a weekly pass. The `baw` session runs in a Cloudflare container, and River's keep-alive holds it up to Binance's 7-day cap (`workers/agent`). |
| Special: BNB Agent Studio | ERC-8004 agent #365864, its plan sold over x402 v2 (b402 or a USDT transfer) and MCP, and the first paid sale on mainnet (see below). |
| Binance Web3 API depth | Six modules: RWA Data, DeFi, Transaction, Market, b402 and the Agentic Wallet (table below). |

## River for agents (https://rivrwa.com/agent)
- **Identity.** River is **ERC-8004 agent #365864** on BSC mainnet, in the IdentityRegistry
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  ([register tx](https://bscscan.com/tx/0x9e91a4d43f369917ccf2e803dfbd7b02de5144dc4940011347cc8d616a499dad),
  [8004scan](https://www.8004scan.io/agents/bsc/365864)). The `agentURI` points at
  `https://api.rivrwa.com/.well-known/agent-registration.json`, which lists its MCP and x402 services.
- **What it sells.** For $0.10 River sells a cycle plan fitted to the caller's inventory: the closed window, the IVL band
  snapped to pool ticks, a deposit that needs no swap, and the exact Binance `lp-add` arguments. The clock, the band and the
  cycle log stay free.
  - **HTTP x402 v2:** `GET https://api.rivrwa.com/v1/paid/plan?symbol=NVDAB&stock=1&usd=250` answers `402` with a
    `PAYMENT-REQUIRED` header.
  - **MCP:** `https://api.rivrwa.com/mcp` exposes `get_weekend_window`, `list_assets`, `get_range` and `get_cycle_report`
    for free, and `plan_cycle` as the paid tool.
- **Two ways to pay:**
  - **b402**, gasless for the payer. It is x402 v2 with Binance as the facilitator: Permit2 for USDT, EIP-3009 for U.
  - **A USDT transfer**, sent with its tx hash. River checks the receipt and burns the hash so it pays for only one plan.
    First real sale, 2026-10-07: 0.10 USDT
    ([tx](https://bscscan.com/tx/0x1bfe700b217e4c1ffca9abf44c4b031f053da28c935e66a03ecc4a541b655a11)) answered with
    `200` + `PAYMENT-RESPONSE`; the same hash a second time got `409`.
- **Self-funding.** Payments land in River's agent wallet, the same address that owns the identity, and that wallet pays
  the agent's own gas.

## Binance Web3 API, module by module
| Module | Endpoints | What River uses it for |
|---|---|---|
| RWA Data | `market/rwa/tokens` | The catalog of the 488 tokenized stocks on BSC, with prices and share ratios |
| DeFi | `investment/list`, `investment/detail`, `position/list`, `lp-add/calculate`, `lp-add`, `lp-remove` | Finding each stock's PancakeSwap v3 pool (the discovery cron) and building every deposit and withdrawal |
| Transaction | `pre-transaction/simulate`, `gas-price`, `gas-limit` | Dry-running every call before River signs it: if a token moves outside account ↔ pool or an allowance changes, River refuses (`packages/core/src/simguard.ts`) |
| Market | `market/candles`, `market/price` | Backing up the signal's candles when the pool feed is down; live prices |
| b402 | `b402/supported`, `verify`, `settle` | Settling the x402 payments other agents make for River's plan |
| Agentic Wallet | `baw` CLI | Flow A: River signs from the user's own Binance wallet |

## Layout
| Path | What |
|---|---|
| `packages/core` | NYSE clock, v3 math (no-swap inventory fit), asset registry, GeckoTerminal source, signal, cycle planner, Binance Web3 client, vendored IVL engine |
| `workers/api` | Public API (Cloudflare Worker): `/v1/clock`, `/v1/assets`, `/v1/stocks` (catalog synced from Binance RWA Data), `/v1/signal/:symbol`, `/v1/plan`, `/v1/backtest`, `/v1/agent`, `/v1/paid/plan` (x402), `/mcp` |
| `agent/` | Cycle runner (idempotent tick) and the Agentic Wallet signer; flow B's Altana signer runs in `workers/agent` |
| `workers/agent` | Private agent Worker: pairing, mandates, the 5-minute cron that runs cycles, Telegram (with the `baw` container in `containers/baw`) |
| `app/` | Web app (React Router on a Worker): landing (tide gauge, replayed backtest, simulator, band schematic, catalog), Binance pairing, Altana wizard, mandate, dashboard, history, `/agent` |
| `scripts/register-agent.ts` | Prints the ERC-8004 `register` tx for the operator to send, then reads the agent id back |
| `research/` | Gate 0 (economics), Gate 0-B (stack feasibility) and the IVL band study |
| `docs/dx-log.md` | Raw facts for the Developer Experience Report |

## Develop
```bash
npm install
npm test                                  # 80 tests: core, agent, agent Worker, app (node --test, TS via type stripping)
node scripts/signal-live.ts               # live signal for every enabled asset (keyless)
node scripts/binance-live.ts              # Binance Web3 API smoke test (needs .env.local)
cd workers/api && npx wrangler dev --port 8788                      # local API (keys in workers/api/.dev.vars)
cd workers/agent && npx wrangler dev --port 8787 --inspector-port 9231   # local agent (needs Docker for the baw container)
cd app && npm run dev                                                # web app on :5173
```

The app reaches the agent and the API through service bindings. Locally it falls back to `AGENT_URL` and `API_URL` from
`app/.dev.vars`, which also holds `INTERNAL_KEY` (the agent's value) and `SESSION_SECRET`.

Secrets are never committed: `.env.local` and `.dev.vars` are git-ignored, and deployed keys go through `wrangler secret put`.
