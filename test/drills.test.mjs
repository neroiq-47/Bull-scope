// Drills: scripted checks of the safety layer. They do not touch the exchange and cannot place orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareOrder } from "../executor/pipeline.mjs";
import { createApproval } from "../executor/safety.mjs";
import { reconcile } from "../executor/reconcile.mjs";
import { parsePairLimits } from "../worker/src/index.js";
import { computePlan } from "../js/strategy.js";

const NOW = 1_700_000_000;
const SECRET = "d".repeat(40);
const proposal = { id: "p-drill", entry: 100000, stop: 97000, target: 106000, expiresAt: new Date((NOW + 600) * 1000).toISOString() };
const plan = computePlan(proposal);
const pairLimits = { minVolumeBase: 0.0001, minCostGbp: 5 };
const market = { price: 100020, lastCandleCloseSeconds: NOW - 60 };
const state = { openPositions: 0, ordersToday: 0, dailyLossGbp: 0, totalLossGbp: 0 };
const noFile = () => false;

function attempt(overrides = {}) {
  const token = createApproval({ proposalId: proposal.id, secret: SECRET, nowSeconds: NOW });
  return prepareOrder({
    proposal, plan, market, state, pairLimits, nowSeconds: NOW, intentId: "drill-1",
    approval: { token, secret: SECRET, consumed: new Set() },
    halt: { env: {}, haltFile: "/x/HALT", fileExists: noFile },
    ...overrides,
  });
}

test("drill: a fully approved, in-limit setup is ready, validate-only", () => {
  const r = attempt();
  assert.equal(r.status, "ready", r.reasons.join("; "));
  assert.equal(r.params.validate, "true");
});

test("drill: kill switch via environment blocks even a perfect setup", () => {
  const r = attempt({ halt: { env: { BULL_SCOPE_HALT: "1" }, haltFile: "/x/HALT", fileExists: noFile } });
  assert.equal(r.status, "blocked");
  assert.equal(r.params, null);
  assert.match(r.reasons.join(" "), /halted/);
});

test("drill: kill switch via halt file blocks", () => {
  const r = attempt({ halt: { env: {}, haltFile: "/x/HALT", fileExists: (p) => p === "/x/HALT" } });
  assert.equal(r.status, "blocked");
});

test("drill: no approval means no order is prepared", () => {
  const r = attempt({ approval: null });
  assert.equal(r.status, "blocked");
  assert.match(r.reasons.join(" "), /no human approval/);
});

test("drill: an approval cannot be replayed for a second order", () => {
  const token = createApproval({ proposalId: proposal.id, secret: SECRET, nowSeconds: NOW });
  const consumed = new Set();
  const first = attempt({ approval: { token, secret: SECRET, consumed } });
  const second = attempt({ approval: { token, secret: SECRET, consumed } });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "blocked");
  assert.match(second.reasons.join(" "), /already used/);
});

test("drill: loss stop blocks even with a valid approval", () => {
  const r = attempt({ state: { ...state, totalLossGbp: 10 } });
  assert.equal(r.status, "blocked");
});

test("drill: reconciliation halts when the exchange reports an order we did not record", () => {
  const r = reconcile({ localIntents: [], remoteOpenOrders: [{ txid: "OX", userref: 42 }] });
  assert.equal(r.ok, false);
  assert.equal(r.action, "halt and review");
});

test("drill: reconciliation halts when a recorded order has vanished from the exchange", () => {
  const r = reconcile({ localIntents: [{ intentId: "i", userref: 7, status: "submitted" }], remoteOpenOrders: [] });
  assert.equal(r.ok, false);
});

test("parsePairLimits reads minimums and refuses when they are missing", () => {
  const ok = parsePairLimits({ XXBTZGBP: { ordermin: "0.0001", costmin: "5", tick_size: "0.1", lot_decimals: 8 } });
  assert.equal(ok.minVolumeBase, 0.0001);
  assert.equal(ok.minCostGbp, 5);
  assert.throws(() => parsePairLimits({ XXBTZGBP: { costmin: "5" } }), /minimums missing/);
});
