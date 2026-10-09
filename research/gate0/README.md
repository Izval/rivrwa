# Gate 0 — Does weekend-only LP on tokenized stocks pay?

**Question.** A holder of a bStock (NVDAB, TSLAB) provides concentrated liquidity on PancakeSwap v3 **only while the
US market is closed** and withdraws before the reopen. The user either keeps the resulting token mix or buys back
to the same number of shares ("restore"). Is that better than simply holding, after every cost?

**Verdict (2026-09-28): PASS.**

## Setup
- **Pools.** PancakeSwap v3 USDT 0.25%, all on BSC mainnet:
  - NVDAB `0x8fb4…690c` (since 29-Jul);
  - TSLAB `0xb0f5…9c41` (since 31-Jul);
  - SPCXB `0x977d…5b4d` (since 12-Jun).
- **Data.**
  - Hourly OHLCV and volume from GeckoTerminal (`fetch.mjs`). Missing hours are carried forward with zero volume.
  - Other LPs' liquidity per tick, read on-chain with `eth_call` (`pool.mjs`). This is a snapshot of today.
- **Window.**
  - Entry: Sat 01:00 UTC, which is Fri 20:00 ET + 1h to settle.
  - Exit: Sun 22:00 UTC, which is 2h before the 20:00 ET reopen.
  - NYSE holidays extend the window.
  - The control is a **weekday** window of the same length (Tue 01:00 → Wed 22:00 UTC).
- **Fees.** Our fee share is `hourVolume × feeTier × L_ours / (L_ours + L_others(tick))` for each hour the close is in range.
- **Costs.** All deducted from the result:
  - impermanent loss vs holding the same tokens;
  - gas of $0.60 per cycle;
  - River fee of 10% of fees + $0.25 per cycle (these exploratory sims; River now charges 5%, see below);
  - restore to the same share count at 0.35% of the swapped value (`sim2.mjs`).
- **Ranges.**
  - Fixed ±2% and ±3%.
  - `ivl`: the IVL engine run on the prior 120h.
  - `adaptive`: 1.2 × the p80 excursion of the previous 4 weekends.

## Results (net APR on committed capital, S = $10k, with restore)

| | Others' liquidity ×1 (today) | ×2 | ×4 (stress) |
|---|---|---|---|
| NVDAB weekend, adaptive | **62.7%** (win 100%) | 27.4% (100%) | 9.5% (89%) |
| NVDAB **weekday**, adaptive | 17.1% (75%, worst −1.5%) | −13.9% | −29.5% |
| TSLAB weekend, adaptive | **35.3%** (100%) | 16.0% (78%) | 6.1% (78%) |
| TSLAB **weekday**, adaptive | −2.6% | −13.3% | −18.7% |

- **The clock is the edge.** The same LP loses during the week, because of gap and trend IL. On weekends the price
  lateralizes: the average 48h range is 2.9% vs 5.8% on weekdays.
- The worst weekend net was **−0.05%** of capital, and only in the ×4 stress case. In the base case, no weekend was below 0.
- Increasing the size from $10k to $50k lowers the APR only slightly.
- **SPCXB is excluded.** It is a pre-IPO asset with no market clock, and its APRs are implausible even on weekdays.

## Caveats (why the real number will be lower)
1. **Short sample.** Only 9 weekends per stock.
2. **Static liquidity.** The other-LP liquidity is today's snapshot. Also, if River succeeds, others will copy it and
   weekend liquidity will rise. The ×2/×4 columns model this.
3. **Volume is volatile and possibly declining.** The weekend of 26-Sep had only $0.54M of NVDAB volume, against a
   $3.7M average.
4. **"Same shares" requires a restore.** Without it, the share count swings 10–90% even though value is preserved.
5. **Hour granularity.** Intra-hour range exits and JIT liquidity are not modelled.

Reproduce: `node pool.mjs <pools…>`, then `node fetch.mjs`, `node sim.mjs` and `node sim2.mjs`. Outputs are in `results-*.txt`.

## Production replay (`sim-core.ts`)
The same windows were re-run through the shipped code: `computeSignal` and `planCycle` from `packages/core`, with
tick-snapped ranges and the no-swap inventory fit. The first window has no history, so it uses the 3% fallback width.
The replay itself now lives in `packages/core/src/gate.ts`, the code the discovery cron uses to enable stocks.
River's fee in these numbers is 5% of LP fees + $0.25 per cycle (it was 10% until 2026-09-29: 63.6% / 37.4%).

| Net APR, S = $10k | Others ×1 | ×2 | ×4 |
|---|---|---|---|
| NVDAB | **67.7%** (win 100%) | 29.3% | 9.7% |
| TSLAB | **39.6%** (win 100%) | 18.8% | 8.1% |

The automatic gate (`gateReport`) passes NVDAB and TSLAB and rejects SPCXB: only 71% of its windows gained (needs
75%). Its APR (339%) is flagged as unusually high, but no longer rejects on its own. The weekday control is still
computed and reported, but it is not a rule since 2026-09-29: the stocks are large companies whose own return is the
base, so any positive net River adds on weekends counts.

- The production band is IVL's μ±2σ over rebased past closed windows (`research/ivl-study`).
- An earlier integration that widened the band on IVL "breakout risk" lowered APR. The cause was mis-calibration,
  documented in that study.
- **These are the headline numbers River quotes. Its public claim is "~8–25% a year on shares that earn 0% today".**
