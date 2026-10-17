// Historical replay of the Bull-Scope signal rules. Analysis only: no network calls, no orders.
//
// Usage:
//   node tools/backtest.mjs --c5 path/to/5m.csv --c15 path/to/15m.csv
//
// CSV format: Kraken OHLC export (time,open,high,low,close,vwap,volume,count). A header line is allowed.
// Use CLOSED candles only. Supply your own data; none is bundled with this project.
//
// Assumptions (deliberately simple, and conservative where it matters):
// - A signal fills at the close of the signal candle, with no slippage.
// - Within one candle, if both stop and target are touched, the stop is assumed to hit first.
// - Fees use the CONFIG.takerFeeRate placeholder on entry and exit.
// - A trade with no exit after maxHoldBars is closed at that bar's close.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CONFIG, computePlan, evaluateSignal } from "../js/strategy.js";

export function parseCandles(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(","))
    .filter((p) => /^\d+$/.test((p[0] || "").trim()))
    .map((p) => ({
      time: Number(p[0]),
      open: Number(p[1]),
      high: Number(p[2]),
      low: Number(p[3]),
      close: Number(p[4]),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

export function settleTrade(open, exitPrice, reason, rate = CONFIG.takerFeeRate) {
  const size = open.plan.sizeGbp;
  const qty = size / open.entry;
  const feesGbp = size * rate + qty * exitPrice * rate;
  const netGbp = qty * (exitPrice - open.entry) - feesGbp;
  return {
    entryTime: open.entryTime,
    entry: open.entry,
    stop: open.stop,
    target: open.target,
    exit: exitPrice,
    reason,
    sizeGbp: size,
    netGbp,
    rMultiple: netGbp / open.plan.riskGbp,
  };
}

export function runBacktest(c5, c15, { maxHoldBars = 48, window = 300 } = {}) {
  const trades = [];
  let open = null;
  let j = 0; // number of 15m candles fully closed at or before the current 5m bar's close

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i];
    const barClose = bar.time + CONFIG.fiveMinSeconds;

    if (open) {
      let exitPrice = null;
      let reason = null;
      if (bar.low <= open.stop) { exitPrice = open.stop; reason = "stop"; }
      else if (bar.high >= open.target) { exitPrice = open.target; reason = "target"; }
      else if (i - open.entryIndex >= maxHoldBars) { exitPrice = bar.close; reason = "timeout"; }
      if (reason) {
        trades.push(settleTrade(open, exitPrice, reason));
        open = null;
      }
      continue;
    }

    while (j < c15.length && c15[j].time + CONFIG.fifteenMinSeconds <= barClose) j++;
    if (i < 21 + CONFIG.pullbackLookback) continue;

    const w5 = c5.slice(Math.max(0, i - window + 1), i + 1);
    const w15 = c15.slice(Math.max(0, j - window), j);
    const sig = evaluateSignal(w15, w5);
    if (sig.proposals.length) {
      const p = sig.proposals[0];
      const plan = computePlan({ entry: p.entry, stop: p.stop, target: p.target });
      if (plan) {
        open = { entry: p.entry, stop: p.stop, target: p.target, entryIndex: i, entryTime: barClose, plan };
      }
    }
  }
  return trades;
}

export function summarise(trades, accountGbp = CONFIG.accountGbp) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netGbp > 0).length;
  const totalNetGbp = trades.reduce((s, t) => s + t.netGbp, 0);
  const avgR = n ? trades.reduce((s, t) => s + t.rMultiple, 0) / n : 0;
  let equity = accountGbp;
  let peak = equity;
  let maxDrawdownGbp = 0;
  for (const t of trades) {
    equity += t.netGbp;
    peak = Math.max(peak, equity);
    maxDrawdownGbp = Math.max(maxDrawdownGbp, peak - equity);
  }
  const exits = {};
  for (const t of trades) exits[t.reason] = (exits[t.reason] || 0) + 1;
  return {
    trades: n,
    winRate: n ? wins / n : 0,
    totalNetGbp,
    avgR,
    maxDrawdownGbp,
    exits,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const c5Path = flag("--c5");
  const c15Path = flag("--c15");
  if (!c5Path || !c15Path) {
    console.error("Usage: node tools/backtest.mjs --c5 <5m.csv> --c15 <15m.csv>");
    process.exit(1);
  }
  const c5 = parseCandles(readFileSync(c5Path, "utf8"));
  const c15 = parseCandles(readFileSync(c15Path, "utf8"));
  const trades = runBacktest(c5, c15);
  const s = summarise(trades);
  console.log("Bull-Scope historical replay (analysis only)");
  console.log(`5m candles: ${c5.length}, 15m candles: ${c15.length}`);
  console.log(`Trades: ${s.trades}`);
  console.log(`Win rate: ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`Average R after fees: ${s.avgR.toFixed(2)}R`);
  console.log(`Total net P&L after fees (GBP): ${s.totalNetGbp.toFixed(2)}`);
  console.log(`Max drawdown (GBP): ${s.maxDrawdownGbp.toFixed(2)}`);
  console.log(`Exits: ${JSON.stringify(s.exits)}`);
  console.log("Fills assumed at signal candle close, no slippage. Past replays do not predict results.");
}
