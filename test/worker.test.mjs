import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import worker, { parseOhlc, parseTicker, signKrakenRequest, nextNonce } from "../worker/src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const SECRET_RAW = Buffer.from("fixture-secret-for-tests-only-0123456789abcdef");
const env = {
  ALLOWED_ORIGINS: "https://site.test",
  KRAKEN_API_KEY: "fixture-public-key",
  KRAKEN_API_SECRET: SECRET_RAW.toString("base64"),
};

function req(path, { method = "GET", origin } = {}) {
  const headers = origin ? { Origin: origin } : {};
  return new Request(`https://worker.test${path}`, { method, headers });
}

function mockKraken(routes) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    for (const [match, respond] of routes) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

test("signKrakenRequest matches an independent HMAC-SHA512 computation", async () => {
  const path = "/0/private/Balance";
  const nonce = "1700000000000";
  const postData = "nonce=1700000000000";
  const sha = createHash("sha256").update(nonce + postData).digest();
  const expected = createHmac("sha512", SECRET_RAW)
    .update(Buffer.concat([Buffer.from(path), sha]))
    .digest("base64");
  assert.equal(await signKrakenRequest(path, postData, nonce, env.KRAKEN_API_SECRET), expected);
});

test("nextNonce strictly increases even within the same millisecond", () => {
  const a = nextNonce(1000);
  const b = nextNonce(1000);
  const c = nextNonce(1000);
  assert.ok(b > a && c > b);
});

test("parseOhlc drops the forming candle and reads fields in order", () => {
  const result = {
    XXBTZGBP: [
      [1, "10", "12", "9", "11", "0", "1", 1],
      [2, "11", "13", "10", "12", "0", "1", 1],
    ],
    last: 2,
  };
  const closed = parseOhlc(result);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { time: 1, open: 10, high: 12, low: 9, close: 11 });
  assert.equal(parseOhlc(result, { dropForming: false }).length, 2);
});

test("parseTicker reads last, bid and ask", () => {
  const t = parseTicker({ XXBTZGBP: { c: ["50000.5", "0.1"], b: ["49999", "1", "1"], a: ["50001", "1", "1"] } });
  assert.deepEqual(t, { last: 50000.5, bid: 49999, ask: 50001 });
});

test("balances return 503 when the read-only key is not configured", async () => {
  const res = await worker.fetch(req("/v1/account/balances"), {});
  assert.equal(res.status, 503);
});

test("non-GET requests are refused", async () => {
  const res = await worker.fetch(req("/v1/account/balances", { method: "POST" }), env);
  assert.equal(res.status, 405);
});

test("balances are read-only, signed, valued in GBP and never echo the secret", async () => {
  let balanceRequest = null;
  mockKraken([
    ["/0/private/Balance", (url, init) => {
      balanceRequest = { url, init };
      return json({ error: [], result: { XXBT: "0.5", ZGBP: "100.00", XXDG: "0" } });
    }],
    ["/0/public/Ticker", () => json({ error: [], result: { XXBTZGBP: { c: ["50000", "1"], b: ["49999", "1", "1"], a: ["50001", "1", "1"] } } })],
  ]);

  const res = await worker.fetch(req("/v1/account/balances", { origin: "https://site.test" }), env);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://site.test");
  assert.ok(!body.includes(env.KRAKEN_API_SECRET), "secret must not appear in responses");
  assert.ok(!body.includes(env.KRAKEN_API_KEY), "key must not appear in responses");

  const data = JSON.parse(body);
  const xbt = data.balances.find((b) => b.asset === "XBT");
  const gbp = data.balances.find((b) => b.asset === "GBP");
  assert.equal(xbt.gbpValue, 25000);
  assert.equal(gbp.gbpValue, 100);
  assert.equal(data.balances.find((b) => b.amount === 0), undefined, "zero balances are filtered");

  assert.equal(balanceRequest.init.headers["API-Key"], env.KRAKEN_API_KEY);
  assert.ok(balanceRequest.init.headers["API-Sign"].length > 0);
});

test("a failed price lookup leaves GBP values null instead of failing", async () => {
  mockKraken([
    ["/0/private/Balance", () => json({ error: [], result: { XXBT: "0.5" } })],
    ["/0/public/Ticker", () => json({ error: ["EGeneral:Temporary lockout"], result: {} })],
  ]);
  const res = await worker.fetch(req("/v1/account/balances"), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.balances[0].gbpValue, null);
});

test("an invalid key from Kraken maps to 401 without leaking details", async () => {
  mockKraken([["/0/private/Balance", () => json({ error: ["EAPI:Invalid key"], result: undefined })]]);
  const res = await worker.fetch(req("/v1/account/balances"), env);
  assert.equal(res.status, 401);
});

test("CORS is granted only to configured origins", async () => {
  mockKraken([["/0/public/Ticker", () => json({ error: [], result: { XXBTZGBP: { c: ["1", "1"], b: ["1", "1", "1"], a: ["1", "1", "1"] } } })]]);
  const denied = await worker.fetch(req("/v1/market/btc-gbp", { origin: "https://evil.test" }), env);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("unknown routes return 404", async () => {
  const res = await worker.fetch(req("/v1/orders/create"), env);
  assert.equal(res.status, 404);
});
