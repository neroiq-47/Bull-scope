// Shared, pure strategy and fee logic.
// Used by the Worker (signal evaluation) and the browser (plan display). No I/O happens here.
// Prices are plain numbers in GBP per BTC.

export const CONFIG = Object.freeze({
  accountGbp: 100,
  riskPct: 0.01,            // risk 1% of the allocation per trade
  capPct: 0.95,             // never allocate more than 95% of the allocation
  takerFeeRate: 0.004,      // PLACEHOLDER per side. Replace with your verified Kraken tier.
  targetR: 2,               // target distance as a multiple of the stop distance
  minNetRewardRatio: 1.0,   // proposals below this reward-to-risk after fees are not shown
  minStopPct: 0.002,        // stop at least 0.2% below entry
  swingLookback: 12,        // 5m candles used to find the swing low
  pullbackLookback: 6,      // 5m candles checked for the dip before the signal candle
  expiryMinutes: 30,        // approval window, measured from the signal candle close
  fiveMinSeconds: 300,
  fifteenMinSeconds: 900,
});

const ASSET_ALIASES = Object.freeze({ XXBT: "XBT", XBT: "XBT", ZGBP: "GBP", GBP: "GBP" });

export function normaliseAsset(code) {
  return ASSET_ALIASES[code] || code;
}

// Returns null when the value cannot be determined, rather than guessing.
export function gbpValueOf(asset, amount, btcGbpPrice) {
  if (asset === "GBP") return amount;
  if (asset === "XBT" && Number.isFinite(btcGbpPrice)) return amount * btcGbpPrice;
  return null;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

// Exponential moving average, aligned to the input: entries before the seed are NaN.
export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Size and fee estimate for a long spot trade.
 * - Position risks riskPct of the allocation if the stop is hit, including fees at the stop.
 * - Fees are taker placeholders charged on entry and on exit.
 * - Returns null for invalid levels.
 */
export function computePlan({
  entry,
  stop,
  target,
  accountGbp = CONFIG.accountGbp,
  riskPct = CONFIG.riskPct,
  capPct = CONFIG.capPct,
  takerFeeRate = CONFIG.takerFeeRate,
}) {
  const perUnitRisk = entry - stop;
  if (!(perUnitRisk > 0) || !(target > entry)) return null;

  const riskBudgetGbp = accountGbp * riskPct;
  const sizeGbp = Math.min(riskBudgetGbp / (perUnitRisk / entry), accountGbp * capPct);
  const qty = sizeGbp / entry;

  const feeEntry = sizeGbp * takerFeeRate;
  const feesIfTarget = feeEntry + qty * target * takerFeeRate;
  const feesIfStopped = feeEntry + qty * stop * takerFeeRate;

  const riskGbp = qty * perUnitRisk + feesIfStopped;
  const netRewardGbp = qty * (target - entry) - feesIfTarget;

  return {
    sizeGbp,
    qty,
    feesGbp: feesIfTarget,        // estimated round trip if the target is hit
    riskGbp,                      // loss if stopped, including estimated fees
    netRewardGbp,                 // profit if the target is hit, after estimated fees
    netRewardRatio: riskGbp > 0 ? netRewardGbp / riskGbp : 0,
  };
}

/**
 * Evaluate the 15-minute trend and 5-minute pullback on CLOSED candles only.
 * c15 and c5 are arrays of { time (seconds), open, high, low, close }, oldest first.
 * The last element of each array must be the most recent closed candle.
 */
export function evaluateSignal(c15, c5, cfg = CONFIG) {
  const result = {
    trend15m: "flat",
    trend15mText: "",
    pullback5m: false,
    pullback5mText: "",
    proposals: [],
    rejectedReason: null,
  };

  if (c15.length < 50 || c5.length < 21 + cfg.pullbackLookback) {
    result.rejectedReason = "Not enough closed candles yet.";
    result.trend15mText = "Waiting for data";
    result.pullback5mText = "Waiting for data";
    return result;
  }

  // 15-minute trend
  const e20h = ema(c15.map((c) => c.close), 20);
  const e50h = ema(c15.map((c) => c.close), 50);
  const i15 = c15.length - 1;
  const last15 = c15[i15];
  const trendUp = e20h[i15] > e50h[i15] && last15.close > e20h[i15];
  result.trend15m = trendUp ? "up" : e20h[i15] < e50h[i15] ? "down" : "flat";
  result.trend15mText = trendUp
    ? "EMA20 above EMA50 and last close above EMA20"
    : "Trend condition not met";

  // 5-minute pullback: a low at or below the 5m EMA20 in the lookback bars, then a bullish close back above it
  const e5 = ema(c5.map((c) => c.close), 20);
  const i5 = c5.length - 1;
  const signalBar = c5[i5];
  let dip = false;
  for (let k = i5 - cfg.pullbackLookback; k < i5; k++) {
    if (k >= 0 && Number.isFinite(e5[k]) && c5[k].low <= e5[k]) { dip = true; break; }
  }
  const reclaim = signalBar.close > e5[i5] && signalBar.close > signalBar.open;
  const bullish = dip && reclaim;
  result.pullback5m = bullish;
  result.pullback5mText = bullish
    ? "Dip to 5m EMA20, then bullish close back above"
    : "No qualifying dip and reclaim";

  if (!trendUp) {
    result.rejectedReason = "15-minute trend not up.";
    return result;
  }
  if (!bullish) {
    result.rejectedReason = "No 5-minute pullback and reclaim.";
    return result;
  }

  // Levels
  const entry = signalBar.close;
  const swingLow = Math.min(...c5.slice(-cfg.swingLookback).map((c) => c.low));
  const stop = Math.min(swingLow * 0.999, entry * (1 - cfg.minStopPct));
  const target = entry + cfg.targetR * (entry - stop);

  const plan = computePlan({ entry, stop, target });
  if (!plan) {
    result.rejectedReason = "Could not place valid levels.";
    return result;
  }
  // Fee gate: a plan is shown only if it still pays after estimated fees.
  if (plan.netRewardRatio < cfg.minNetRewardRatio) {
    result.rejectedReason =
      `After estimated fees the reward-to-risk is ${plan.netRewardRatio.toFixed(2)}R, ` +
      `below the ${cfg.minNetRewardRatio.toFixed(1)}R minimum. Fees are too high for a stop this tight.`;
    return result;
  }

  const closeSeconds = signalBar.time + cfg.fiveMinSeconds;
  result.proposals.push({
    id: `p-${signalBar.time}`,
    entry: round2(entry),
    stop: round2(stop),
    target: round2(target),
    expiresAt: new Date((closeSeconds + cfg.expiryMinutes * 60) * 1000).toISOString(),
  });
  return result;
}
