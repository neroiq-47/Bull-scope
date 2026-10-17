import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandles, runBacktest, settleTrade, summarise } from "../tools/backtest.mjs";

// Synthetic fixtures for logic tests only. These are not market data.
const T0 = 1_700_000_000;

test("parseCandles skips a header and sorts by time", () => {
  const csv = "time,open,high,low,close,vwap,volume,count\n600,1,2,0.5,1.5,0,0,0\n300,1,2,0.5,1.2,0,0,0\n";
  const rows = parseCandles(csv);
  assert.deepEqual(rows.map((r) => r.time), [300, 600]);
});

test("flat data produces no trades", () => {
  const c5 = Array.from({ length: 80 }, (_, i) => ({ time: T0 + i * 300, open: 100, high: 100, low: 100, close: 100 }));
  const c15 = Array.from({ length: 60 }, (_, k) => ({ time: T0 + k * 900, open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(runBacktest(c5, c15).length, 0);
});

test("a signal opens a paper trade that closes at target on a later bar", () => {
  // Synthetic fixture for logic only. Not market data.
  const c15 = Array.from({ length: 60 }, (_, k) => {
    const close = 100 + k * 0.1;
    return { time: T0 - 60 * 900 + k * 900, open: close - 0.05, high: close + 0.1, low: close - 0.1, close };
  });
  const c5 = Array.from({ length: 30 }, (_, i) => {
    const close = 110 + i * 0.1;
    const low = i === 25 ? 100 : close - 0.1; // the pullback dip
    return { time: T0 + i * 300, open: close - 0.05, high: close + 0.1, low, close };
  });
  c5.push({ time: T0 + 30 * 300, open: 112.9, high: 140, low: 112, close: 139 }); // touches the target
  const trades = runBacktest(c5, c15);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].reason, "target");
  assert.ok(trades[0].rMultiple > 1.5 && trades[0].rMultiple < 2, `R ${trades[0].rMultiple}`);
});

test("settleTrade gives a stop loss around -1R before fees on a 2R plan", () => {
  const plan = { sizeGbp: 33.33, riskGbp: 1.26, qty: 33.33 / 100000 };
  const open = { entry: 100000, stop: 97000, target: 106000, plan, entryTime: T0 };
  const t = settleTrade(open, 97000, "stop");
  assert.equal(t.reason, "stop");
  assert.ok(t.netGbp < 0, "a stop exit must lose money after fees");
  assert.ok(t.rMultiple < -0.9 && t.rMultiple > -1.3, `unexpected R ${t.rMultiple}`);
});

test("summarise computes win rate, drawdown and totals", () => {
  const trades = [
    { netGbp: 2, rMultiple: 2, reason: "target" },
    { netGbp: -1, rMultiple: -1, reason: "stop" },
    { netGbp: -2, rMultiple: -2, reason: "stop" },
  ];
  const s = summarise(trades, 100);
  assert.equal(s.trades, 3);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.totalNetGbp - -1) < 1e-9);
  assert.ok(Math.abs(s.maxDrawdownGbp - 3) < 1e-9, "peak 102, trough 99");
  assert.deepEqual(s.exits, { target: 1, stop: 2 });
});
