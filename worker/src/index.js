// Bull-Scope server component (Cloudflare Worker).
// - Holds the Kraken READ-ONLY key as Worker secrets (KRAKEN_API_KEY, KRAKEN_API_SECRET).
// - Exposes only: public BTC/GBP ticker, public OHLC-based signal, and the private Balance call.
// - No order, withdrawal, deposit or leverage endpoints exist here.
// - Secrets are never returned to the browser.

import { evaluateSignal, gbpValueOf, normaliseAsset } from "../../js/strategy.js";

export const KRAKEN = "https://api.kraken.com";
export const PAIR = "XBTGBP";

/* ---------- Helpers ---------- */

export function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function parseAllowedOrigins(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept",
    "Vary": "Origin",
  };
  if (origin && parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders(request, env),
    },
  });
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

// Kraken requires nonces that strictly increase for each key. Keep a monotonic counter per isolate.
let lastNonce = 0;
export function nextNonce(now = Date.now()) {
  lastNonce = Math.max(now * 1000, lastNonce + 1);
  return lastNonce;
}

/* ---------- Kraken public data (no key) ---------- */

export async function krakenPublic(path, params = {}) {
  const url = new URL(`${KRAKEN}/0/public/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await globalThis.fetch(url, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({ error: ["Invalid response from Kraken"] }));
  if (body.error && body.error.length) throw httpError(body.error.join("; "), 502);
  return body.result;
}

// Ticker: c = last trade [price, lot volume], b = bid, a = ask.
export function parseTicker(result) {
  const t = Object.values(result || {})[0];
  if (!t) throw httpError("Ticker result missing", 502);
  return { last: Number(t.c[0]), bid: Number(t.b[0]), ask: Number(t.a[0]) };
}

// OHLC rows: [time, open, high, low, close, vwap, volume, count]. The final row is the still-forming
// candle, so it is dropped by default. Signals use closed candles only.
export function parseOhlc(result, { dropForming = true } = {}) {
  const key = Object.keys(result || {}).find((k) => k !== "last");
  if (!key) throw httpError("OHLC result missing", 502);
  const rows = dropForming ? result[key].slice(0, -1) : result[key];
  return rows.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
  }));
}

export async function getTicker() {
  const result = await krakenPublic("Ticker", { pair: PAIR });
  return {
    pair: "BTC/GBP",
    ...parseTicker(result),
    asOf: new Date().toISOString(),
    source: "Kraken public ticker",
  };
}

export async function getSignal() {
  const [r15, r5] = await Promise.all([
    krakenPublic("OHLC", { pair: PAIR, interval: 15 }),
    krakenPublic("OHLC", { pair: PAIR, interval: 5 }),
  ]);
  const signal = evaluateSignal(parseOhlc(r15), parseOhlc(r5));
  return { ...signal, asOf: new Date().toISOString() };
}

/* ---------- Kraken private (read-only) ---------- */

// API-Sign = base64( HMAC-SHA512( base64decode(secret), path + SHA256(nonce + postData) ) )
export async function signKrakenRequest(path, postData, nonce, secretB64) {
  const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce + postData));
  const message = concatBytes(new TextEncoder().encode(path), new Uint8Array(sha));
  const key = await crypto.subtle.importKey(
    "raw", base64ToBytes(secretB64), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, message);
  return bytesToBase64(new Uint8Array(sig));
}

export function classifyKrakenError(messages) {
  const text = messages.join("; ");
  if (/Invalid key|Permission denied|Invalid signature/i.test(text)) return 401;
  if (/Rate limit/i.test(text)) return 429;
  return 502;
}

export async function fetchKrakenBalances(env) {
  if (!env.KRAKEN_API_KEY || !env.KRAKEN_API_SECRET) {
    throw httpError("Kraken read-only key is not configured.", 503);
  }
  const path = "/0/private/Balance";
  const nonce = String(nextNonce());
  const postData = new URLSearchParams({ nonce }).toString();
  const sign = await signKrakenRequest(path, postData, nonce, env.KRAKEN_API_SECRET);

  const res = await globalThis.fetch(`${KRAKEN}${path}`, {
    method: "POST",
    headers: {
      "API-Key": env.KRAKEN_API_KEY,
      "API-Sign": sign,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
  });
  const body = await res.json().catch(() => ({ error: ["Invalid response from Kraken"] }));
  if (body.error && body.error.length) throw httpError(body.error.join("; "), classifyKrakenError(body.error));
  return body.result;
}

export async function getBalances(env) {
  const result = await fetchKrakenBalances(env);
  // A failed price lookup leaves GBP values null. It does not fail the balance request.
  let btcGbp = null;
  try { btcGbp = (await getTicker()).last; } catch { btcGbp = null; }
  return Object.entries(result)
    .map(([code, amount]) => {
      const asset = normaliseAsset(code);
      const amt = Number(amount);
      return { asset, amount: amt, gbpValue: gbpValueOf(asset, amt, btcGbp) };
    })
    .filter((b) => b.amount > 0);
}

/* ---------- Router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== "GET") return json({ message: "Method not allowed" }, 405, request, env);

    try {
      if (url.pathname === "/v1/market/btc-gbp") {
        return json(await getTicker(), 200, request, env);
      }
      if (url.pathname === "/v1/signal/btc-gbp") {
        return json(await getSignal(), 200, request, env);
      }
      if (url.pathname === "/v1/account/balances") {
        return json({ balances: await getBalances(env), valuedInGbp: true }, 200, request, env);
      }
      if (url.pathname === "/v1/account/status") {
        await fetchKrakenBalances(env);
        return json({ connected: true, permissions: ["Query Funds (read-only)"] }, 200, request, env);
      }
      return json({ message: "Not found" }, 404, request, env);
    } catch (err) {
      return json({ message: err.message || "Server error" }, err.status || 502, request, env);
    }
  },
};
