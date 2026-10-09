# River agent — cycle runner

Runs one mandate: it waits for the NYSE closed window, puts the allocated bStock + USDT into a PancakeSwap v3
band (IVL μ±2σ, no swap), and removes it before the reopen. The planner in `packages/core` decides every step;
the signer only signs. Everything stays in the user's wallet.

```bash
node agent/src/main.ts status   --mandate agent/mandates/nvdab.json [--at 2026-10-03T01:30:00Z]
node agent/src/main.ts tick     --mandate agent/mandates/nvdab.json --dry-run   # previews the txs, sends nothing
node agent/src/main.ts run      --mandate agent/mandates/nvdab.json             # ticks every 5 min
node agent/src/main.ts exit-now --mandate agent/mandates/nvdab.json             # remove the position now
node agent/src/main.ts resume   --mandate agent/mandates/nvdab.json             # clear a halt after checking by hand
```

State lives in `agent/state/` (git-ignored). Each tx is saved before the runner waits for it, so a restart
never sends twice. Finished cycles are appended to `agent/state/cycles.jsonl` with every tx hash.

## Flow A — Binance Agentic Wallet: checklist before a weekend
The session is tied to this machine and lasts at most 48h, so run the agent here, and sign in on **Friday
evening** so the session covers the exit (Sunday 22:00 UTC for a normal weekend).

1. `npm install -g @binance/agentic-wallet` (CLI `baw`, ≥ 1.10).
2. `baw auth signin --json`, open `urlForWeb`, confirm in the Binance App, then `baw auth verify --qrCodeId <id> --json`.
   `baw wallet status --json` must say `CONNECTED`.
3. In the Binance App (Agentic Wallet settings):
   - `defiDailyLimit` ≥ the value you allocate (lp-add counts against it);
   - `abnormalTxnHandling` = `AutoReject`, otherwise a flagged tx waits for you in the App;
   - allow the bStock if `tradeAllTokens` is off.
4. Hold both legs (e.g. NVDAB **and** USDT) plus a little BNB for gas. The band is fitted to your ratio; no swap happens.
5. Copy `mandates/nvdab.example.json` to `mandates/nvdab.json` and set `owner` to the wallet's BSC address
   (`baw wallet address --json`).
6. `status` (check the session covers the exit), then `tick --dry-run` once the window is open, then
   `caffeinate -i node agent/src/main.ts run --mandate agent/mandates/nvdab.json`.

## Flow B — Altana (not yet)
Needs the passkey session grant from `app/`. Then an `AltanaSigner` implements the same `Signer` interface.
