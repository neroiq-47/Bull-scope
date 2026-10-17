// Pre-trade checks. Pure functions: no I/O, no clock reads (time is passed in).
// Every check that can refuse a trade is here, so the refusal logic can be tested without an exchange.
// Starting values come from docs/TRADING-PLAN.md and are placeholders for you to set.

export const LIMITS = Object.freeze({
  accountGbp: 100,
  maxPositions: 1,
  maxOrdersPerDay: 2,
  dailyLossStopPct: 0.02,   // 2% of allocation
  totalLossStopPct: 0.10,   // 10% of allocation
  maxDeviationPct: 0.003,   // limit must be within 0.3% of the signal price
  maxCandleAgeSeconds: 600,
});

/**
 * @param {object} input
 * @param {object} input.proposal   { entry, stop, target, expiresAt }
 * @param {object} input.plan       output of computePlan (sizeGbp, qty, netRewardRatio)
 * @param {object} input.market     { price, lastCandleCloseSeconds }
 * @param {object} input.state      { openPositions, ordersToday, dailyLossGbp, totalLossGbp }
 * @param {object} input.pairLimits { minVolumeBase, minCostGbp } read from Kraken AssetPairs at runtime
 * @param {number} input.nowSeconds
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function checkPreTrade({ proposal, plan, market, state, pairLimits, nowSeconds, limits = LIMITS }) {
  const reasons = [];

  if (!plan) reasons.push("plan could not be computed");
  if (!pairLimits || !(pairLimits.minVolumeBase > 0) || !(pairLimits.minCostGbp > 0)) {
    reasons.push("pair minimums unavailable: refusing rather than guessing");
  }
  if (plan && pairLimits) {
    // Never round up to meet a minimum. A trade below the minimum is simply not taken.
    if (plan.qty < pairLimits.minVolumeBase) reasons.push(`size ${plan.qty} BTC is below the Kraken minimum ${pairLimits.minVolumeBase} BTC`);
    if (plan.sizeGbp < pairLimits.minCostGbp) reasons.push(`size £${plan.sizeGbp.toFixed(2)} is below the Kraken minimum £${pairLimits.minCostGbp}`);
  }

  if (!(plan && plan.netRewardRatio >= 1)) reasons.push("reward-to-risk after fees is below 1.0R");

  if (Date.parse(proposal.expiresAt) <= nowSeconds * 1000) reasons.push("proposal has expired");

  if (state.openPositions >= limits.maxPositions) reasons.push("maximum open positions reached");
  if (state.ordersToday >= limits.maxOrdersPerDay) reasons.push("daily order limit reached");

  if (state.dailyLossGbp >= limits.accountGbp * limits.dailyLossStopPct) {
    reasons.push("daily loss stop reached: no new orders until next day and manual review");
  }
  if (state.totalLossGbp >= limits.accountGbp * limits.totalLossStopPct) {
    reasons.push("total loss stop reached: trading halted until manual review");
  }

  const deviation = Math.abs(market.price - proposal.entry) / proposal.entry;
  if (!(deviation <= limits.maxDeviationPct)) {
    reasons.push(`market has moved ${(deviation * 100).toFixed(2)}% from the signal price`);
  }

  const candleAge = nowSeconds - market.lastCandleCloseSeconds;
  if (!(candleAge >= 0 && candleAge <= limits.maxCandleAgeSeconds)) {
    reasons.push("signal candle is stale or missing");
  }

  return { allowed: reasons.length === 0, reasons };
}
