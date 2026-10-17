import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, computePlan, ema, evaluateSignal, gbpValueOf, normaliseAsset } from "../js/strategy.js";

// Synthetic fixtures for logic tests only. These are not market data.
function risingFifteen(count = 60) {
  return Array.from({ length: count }, (_, k) => {
    const close = 100 + k * 0.1;
    return { time: 1_700_000_000 + k * 900, open: close - 0.05, high: close + 0.1, low: close - 0.1, close };
  });
}

function fiveMinFixture({ dipLow = null, count = 30 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const close = 110 + i * 0.1;
    const low = i === 25 && dipLow !== null ? dipLow : close - 0.1;
    return { time: 1_700_000_000 + i * 300, open: close - 0.05, high: close + 0.1, low, close };
  });
}

test("ema seeds with a simple average and keeps alignment", () => {
  const out = ema([1, 2, 3, 4], 2);
  assert.ok(Number.isNaN(out[0]));
  assert.equal(out[1], 1.5);
  assert.ok(Math.abs(out[2] - 2.5) < 1e-9);
  assert.ok(Math.abs(out[3] - 3.5) < 1e-9);
});

test("ema returns all NaN when there is not enough data", () => {
  assert.ok(ema([1, 2], 5).every(Number.isNaN));
});

test("sizing is capped at 95% of the allocation for a wide stop", () => {
  // 1% stop: the 1% risk budget would allow £100, so the cap applies.
  const plan = computePlan({ entry: 100000, stop: 99000, target: 102000 });
  assert.equal(plan.sizeGbp, 95);
});

test("a 1% stop does not pay after estimated fees", () => {
  const plan = computePlan({ entry: 100000, stop: 99000, target: 102000 });
  assert.ok(plan.netRewardRatio < 1, `expected below 1R, got ${plan.netRewardRatio}`);
});

test("a 3% stop pays after estimated fees", () => {
  const plan = computePlan({ entry: 100000, stop: 97000, target: 106000 });
  assert.ok(plan.netRewardRatio >= 1, `expected at least 1R, got ${plan.netRewardRatio}`);
  assert.ok(Math.abs(plan.riskGbp - 1.26) < 0.02, `risk should be about £1 plus fees, got ${plan.riskGbp}`);
});

test("computePlan rejects invalid levels", () => {
  assert.equal(computePlan({ entry: 100, stop: 101, target: 110 }), null);
  assert.equal(computePlan({ entry: 100, stop: 99, target: 99 }), null);
});

test("fee estimates use the configured placeholder rate", () => {
  const plan = computePlan({ entry: 100000, stop: 97000, target: 106000 });
  const expectedFees = plan.sizeGbp * CONFIG.takerFeeRate + plan.qty * 106000 * CONFIG.takerFeeRate;
  assert.ok(Math.abs(plan.feesGbp - expectedFees) < 1e-9);
});

test("evaluateSignal reports insufficient data", () => {
  const r = evaluateSignal(risingFifteen(10), fiveMinFixture({ count: 5 }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.rejectedReason, "Not enough closed candles yet.");
});

test("evaluateSignal rejects when the 15-minute trend is down", () => {
  const falling = risingFifteen(60).reverse().map((c, k) => ({ ...c, time: 1_700_000_000 + k * 900 }));
  const r = evaluateSignal(falling, fiveMinFixture({ dipLow: 100 }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.rejectedReason, "15-minute trend not up.");
});

test("evaluateSignal rejects without a pullback", () => {
  const r = evaluateSignal(risingFifteen(), fiveMinFixture({ dipLow: null }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.rejectedReason, "No 5-minute pullback and reclaim.");
});

test("evaluateSignal produces a proposal when trend and pullback align and fees still pay", () => {
  const r = evaluateSignal(risingFifteen(), fiveMinFixture({ dipLow: 100 }));
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.ok(p.stop < p.entry && p.target > p.entry);
  assert.ok(Math.abs((p.target - p.entry) - 2 * (p.entry - p.stop)) < 0.02, "target should be 2R");
  assert.ok(Date.parse(p.expiresAt) > Date.now() - 1e12);
});

test("evaluateSignal rejects a tight-stop setup whose fees exceed its reward", () => {
  // A dip at 111.5 gives a stop about 1.3% below entry, which does not pay after estimated fees.
  const r = evaluateSignal(risingFifteen(), fiveMinFixture({ dipLow: 111.5 }));
  assert.equal(r.proposals.length, 0);
  assert.match(r.rejectedReason, /reward-to-risk/);
});

test("break-even stop distance is about 1.6% at the placeholder fee rate", () => {
  const at = (pct) => computePlan({ entry: 100000, stop: 100000 * (1 - pct), target: 100000 * (1 + 2 * pct) }).netRewardRatio;
  assert.ok(at(0.014) < 1, "1.4% stop should not pay");
  assert.ok(at(0.018) > 1, "1.8% stop should pay");
});

test("normaliseAsset maps Kraken balance codes", () => {
  assert.equal(normaliseAsset("XXBT"), "XBT");
  assert.equal(normaliseAsset("ZGBP"), "GBP");
  assert.equal(normaliseAsset("XXDG"), "XXDG");
});

test("gbpValueOf returns null rather than guessing", () => {
  assert.equal(gbpValueOf("GBP", 12.5, null), 12.5);
  assert.equal(gbpValueOf("XBT", 0.5, 50000), 25000);
  assert.equal(gbpValueOf("XBT", 0.5, null), null);
  assert.equal(gbpValueOf("ETH", 1, 2000), null);
});
