import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreTrade, LIMITS } from "../executor/limits.mjs";
import { isHalted, createApproval, verifyApproval } from "../executor/safety.mjs";
import { buildValidateOrder, assertValidateOnly, userrefFor } from "../executor/order.mjs";
import { validateOrder } from "../executor/validate.mjs";
import { reconcile } from "../executor/reconcile.mjs";
import { computePlan } from "../js/strategy.js";

const NOW = 1_700_000_000;
const proposal = { entry: 100000, stop: 97000, target: 106000, expiresAt: new Date((NOW + 600) * 1000).toISOString() };
const plan = computePlan(proposal);
const pairLimits = { minVolumeBase: 0.0001, minCostGbp: 5, tickSize: 0.1, lotDecimals: 8 };
const market = { price: 100050, lastCandleCloseSeconds: NOW - 120 };
const cleanState = { openPositions: 0, ordersToday: 0, dailyLossGbp: 0, totalLossGbp: 0 };
const run = (over = {}) => checkPreTrade({ proposal, plan, market, state: cleanState, pairLimits, nowSeconds: NOW, ...over });

test("a clean setup is allowed", () => {
  const r = run();
  assert.equal(r.allowed, true, r.reasons.join("; "));
});

test("missing pair minimums refuse rather than guess", () => {
  const r = run({ pairLimits: null });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /pair limits unavailable/);
});

test("missing tick size or lot decimals refuse rather than guess", () => {
  assert.equal(run({ pairLimits: { minVolumeBase: 0.0001, minCostGbp: 5 } }).allowed, false);
  assert.equal(run({ pairLimits: { minVolumeBase: 0.0001, minCostGbp: 5, tickSize: 0.1 } }).allowed, false);
});

test("approval tokens with extra segments are malformed", () => {
  const secret = "x".repeat(40);
  const token = createApproval({ proposalId: "p-9", secret, nowSeconds: NOW });
  const tampered = `${token}.extra`;
  assert.equal(verifyApproval({ token: tampered, secret, proposalId: "p-9", nowSeconds: NOW, consumed: new Set() }).reason, "malformed token");
});

test("used-token records persist across restarts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConsumed, saveConsumed } = await import("../executor/safety.mjs");
  const dir = mkdtempSync(join(tmpdir(), "bull-scope-consumed-"));
  const path = join(dir, "consumed.json");
  try {
    const secret = "x".repeat(40);
    const consumed = loadConsumed(path);
    const token = createApproval({ proposalId: "p-10", secret, nowSeconds: NOW });
    assert.equal(verifyApproval({ token, secret, proposalId: "p-10", nowSeconds: NOW, consumed }).ok, true);
    saveConsumed(path, consumed);
    // Simulate a restart: reload from disk. The same token must now be refused.
    const after = loadConsumed(path);
    assert.equal(verifyApproval({ token, secret, proposalId: "p-10", nowSeconds: NOW, consumed: after }).reason, "token already used");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prices round down to the tick and volumes round down to lot precision", () => {
  const params = buildValidateOrder({ intentId: "i-r", volumeBase: 0.00123456789, limitPrice: 100000.09, expireAtSeconds: NOW + 1800, tickSize: 0.1, lotDecimals: 8 });
  assert.equal(params.price, "100000.0");
  assert.equal(params.volume, "0.00123456");
});

test("building an order without tick size or lot decimals throws", () => {
  assert.throws(() => buildValidateOrder({ intentId: "i-x", volumeBase: 0.001, limitPrice: 100000, expireAtSeconds: NOW + 1800 }), /required/);
});

test("a size below the Kraken minimum is refused, not rounded up", () => {
  const r = run({ pairLimits: { minVolumeBase: 1, minCostGbp: 5 } });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /below the Kraken minimum/);
});

test("each loss stop blocks trading", () => {
  assert.equal(run({ state: { ...cleanState, dailyLossGbp: LIMITS.accountGbp * LIMITS.dailyLossStopPct } }).allowed, false);
  assert.equal(run({ state: { ...cleanState, totalLossGbp: LIMITS.accountGbp * LIMITS.totalLossStopPct } }).allowed, false);
});

test("order-count and position limits block trading", () => {
  assert.equal(run({ state: { ...cleanState, ordersToday: LIMITS.maxOrdersPerDay } }).allowed, false);
  assert.equal(run({ state: { ...cleanState, openPositions: LIMITS.maxPositions } }).allowed, false);
});

test("a market move beyond the deviation limit blocks trading", () => {
  const r = run({ market: { price: 100500, lastCandleCloseSeconds: NOW - 60 } });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /moved/);
});

test("stale candles block trading", () => {
  assert.equal(run({ market: { price: 100050, lastCandleCloseSeconds: NOW - 3600 } }).allowed, false);
});

test("expired proposals block trading", () => {
  const expired = { ...proposal, expiresAt: new Date((NOW - 1) * 1000).toISOString() };
  assert.equal(run({ proposal: expired }).allowed, false);
});

test("kill switch halts on the environment flag or the halt file", () => {
  assert.equal(isHalted({ env: { BULL_SCOPE_HALT: "1" } }).halted, true);
  assert.equal(isHalted({ haltFile: "/x/HALT", fileExists: (p) => p === "/x/HALT" }).halted, true);
  assert.equal(isHalted({ env: {}, haltFile: "/x/HALT", fileExists: () => false }).halted, false);
});

test("approval tokens verify once, expire and bind to one proposal", () => {
  const secret = "x".repeat(40);
  const consumed = new Set();
  const token = createApproval({ proposalId: "p-1", secret, nowSeconds: NOW });
  assert.equal(verifyApproval({ token, secret, proposalId: "p-1", nowSeconds: NOW + 10, consumed }).ok, true);
  assert.equal(verifyApproval({ token, secret, proposalId: "p-1", nowSeconds: NOW + 10, consumed }).reason, "token already used");

  const t2 = createApproval({ proposalId: "p-2", secret, nowSeconds: NOW, ttlSeconds: 60 });
  assert.equal(verifyApproval({ token: t2, secret, proposalId: "p-2", nowSeconds: NOW + 120, consumed: new Set() }).reason, "token expired");
  assert.equal(verifyApproval({ token: t2, secret, proposalId: "p-OTHER", nowSeconds: NOW, consumed: new Set() }).reason, "token is for a different proposal");
  assert.equal(verifyApproval({ token: t2, secret: "y".repeat(40), proposalId: "p-2", nowSeconds: NOW, consumed: new Set() }).reason, "bad signature");
});

test("approval secrets must be strong enough", () => {
  assert.throws(() => createApproval({ proposalId: "p", secret: "short", nowSeconds: NOW }));
});

test("built orders are always validate-only", () => {
  const params = buildValidateOrder({ intentId: "i-1", volumeBase: 0.001, limitPrice: 100000, expireAtSeconds: NOW + 1800, tickSize: 0.1, lotDecimals: 8 });
  assert.equal(params.validate, "true");
  assert.equal(params.pair, "XBTGBP");
  assert.equal(params.type, "buy");
  assert.equal(params.ordertype, "limit");
});

test("assertValidateOnly refuses any request without validate=true", () => {
  assert.throws(() => assertValidateOnly({ pair: "XBTGBP" }), /validate=true/);
  assert.throws(() => assertValidateOnly({ pair: "XBTGBP", validate: "false" }), /validate=true/);
});

test("validateOrder refuses to send a request without validate=true", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response("{}"); };
  await assert.rejects(() => validateOrder({ params: { pair: "XBTGBP" }, nonce: 1, env: {}, fetchImpl }), /validate=true/);
  assert.equal(called, false);
});

test("validateOrder fails loudly if Kraken ever returns a txid", async () => {
  const env = { KRAKEN_TRADE_API_KEY: "k", KRAKEN_TRADE_API_SECRET: Buffer.from("s".repeat(20)).toString("base64") };
  const fetchImpl = async () => new Response(JSON.stringify({ error: [], result: { txid: ["OABC-1"] } }));
  const params = buildValidateOrder({ intentId: "i-2", volumeBase: 0.001, limitPrice: 100000, expireAtSeconds: NOW + 1800, tickSize: 0.1, lotDecimals: 8 });
  await assert.rejects(() => validateOrder({ params, nonce: NOW * 1000, env, fetchImpl }), /unexpected txid/);
});

test("validateOrder returns the description when Kraken only validates", async () => {
  const env = { KRAKEN_TRADE_API_KEY: "k", KRAKEN_TRADE_API_SECRET: Buffer.from("s".repeat(20)).toString("base64") };
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/0\/private\/AddOrder$/);
    assert.match(init.body, /validate=true/);
    return new Response(JSON.stringify({ error: [], result: { descr: { order: "buy 0.00100000 XBTGBP @ limit 100000.00" } } }));
  };
  const params = buildValidateOrder({ intentId: "i-3", volumeBase: 0.001, limitPrice: 100000, expireAtSeconds: NOW + 1800, tickSize: 0.1, lotDecimals: 8 });
  const r = await validateOrder({ params, nonce: NOW * 1000, env, fetchImpl });
  assert.match(r.description, /buy/);
});

test("userref is a stable positive integer per intent", () => {
  assert.equal(userrefFor("abc"), userrefFor("abc"));
  assert.ok(Number.isInteger(userrefFor("abc")) && userrefFor("abc") > 0);
});

test("reconcile is ok when local and exchange agree", () => {
  const r = reconcile({
    localIntents: [{ intentId: "a", userref: 5, status: "submitted" }],
    remoteOpenOrders: [{ txid: "O1", userref: 5 }],
  });
  assert.equal(r.ok, true);
});

test("reconcile halts on an order the exchange does not show, and on one we never recorded", () => {
  const missing = reconcile({ localIntents: [{ intentId: "a", userref: 5, status: "submitted" }], remoteOpenOrders: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.missingRemote.length, 1);

  const unknown = reconcile({ localIntents: [], remoteOpenOrders: [{ txid: "O9", userref: 9 }] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknownRemote.length, 1);
});
