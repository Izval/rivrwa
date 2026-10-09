# IVL on tokenized stocks — case study

**Question.** IVL (Internal Variance of Lateralization) was built to judge sideways ranges for concentrated
liquidity on crypto pairs. Does it help River decide *where* to place a bStock's weekend liquidity? If so, how
should it be used?

**Answer.** Yes, by a wide margin, but only when it measures the right thing. IVL's σ band (μ ± 2σ), measured
on past closed-market windows that are each rebased to their own entry price, raised River's net APR in every
scenario we tested:

| Net APR, $10k position (production replay) | Before: excursion band | **With IVL μ±2σ** | Uplift |
|---|---|---|---|
| NVDAB, other LPs as today | 45.0% | **63.6%** | +41% |
| NVDAB, other LPs ×4 (stress) | 5.7% | **8.7%** | +53% |
| TSLAB, other LPs as today | 21.8% | **37.4%** (win rate 88% → 100%) | +72% |
| TSLAB, other LPs ×4 (stress) | 4.2% | **7.6%** | +81% |

All figures are net of impermanent loss, gas, River's fee (10% + $0.25) and the cost of restoring the same share count.

## What went wrong first, and why it matters
The first integration made results *worse*. It used IVL's `breakoutRisk` to widen the band, and the study found
two separate problems with that:

1. **Wrong sample.** Four past weekends were concatenated in price space. Because NVDA drifted between weekends,
   the range W measured the multi-week trend, not the lateralization inside a closed window. Rebasing each window
   to its entry price fixes this.
2. **Wrong calibration.** IVL's action thresholds (`raw = σ²/W²`: withdraw < 0.10, concentrate ≥ 0.18) come from
   15-minute crypto candles. In thin stock-token pools a single large swap leaves a wick that inflates W, so `raw`
   sits at 0.01–0.05 in *every* window (see `diagnose.ts`). The engine therefore flagged "breakout" everywhere:
   - the widen policies A1 and A2 widened in every window, so they produced identical results;
   - the 168h gate C1 abstained in every window.

   These are calibration artifacts, not signals.

**What transfers is IVL's dispersion core.** σ, the VWAP-weighted dispersion, is robust to single wicks and
describes how price actually oscillates while the market is closed. On the rebased NVDAB weekends, σ was about
0.6–0.8%, so μ±2σ gives about ±1.2–1.6%. The excursion rule, which is driven by wicks, gave ±2–3.5%. The tighter
band earns more fees, and the weekend lateralization keeps price inside it.

## Policies tested (`study.ts`, all 45h windows, weekend vs weekday)
| Policy | Idea | Weekend result |
|---|---|---|
| A0 | Excursion band (p80 × 1.2), no IVL | baseline |
| A1 / A2 | Widen ×1.5 on IVL breakout (raw / rebased) | worse: always widens (calibration artifact) |
| **B1** | **IVL μ±2σ on rebased past closed windows** | **best in 6/6 scenarios** |
| B2 | IVL μ±2σ on the 168h lookback | worse: weekday trend inflates σ |
| C1 | Abstain when IVL(168h) says withdraw | never deploys (calibration artifact) |
| D1 | Re-measure IVL at +12h/+24h, concentrate or exit | worse: extra actions + noisy short samples |

- **Weekday control.** B1 does *not* rescue weekday windows; trending weeks lose with any band. IVL measures
  lateralization, and the market clock is what decides that lateralization exists.
- **Robustness (`sweep-B1.txt`).** B1 beat A0 in all 16 variants (σ multiple 1.5/2/2.5/3 × lookback 2/3/4/6
  windows) and all 6 cost scenarios. Narrower (1.5σ) scored higher, but production keeps IVL's untuned **2σ**.
  With 8 weekends per asset, tuning further would be overfitting.

## Takeaways for IVL itself
- IVL generalizes to RWA pools **when fed the regime being traded**: closed-market windows, rebased.
- Its raw thresholds need **per-asset-class calibration** before they can drive actions on thin pools. A candidate
  fix for the engine is a wick-robust W, such as a p5–p95 close range instead of min low / max high.
- River uses IVL for the band and shows the score for transparency. It takes no action from the classification.

Reproduce: `node research/ivl-study/study.ts` (the full table goes to `results.txt`, per-window rows to `results.json`),
`node research/ivl-study/diagnose.ts`, and `node research/gate0/sim-core.ts` for the production replay.
