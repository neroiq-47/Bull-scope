// Validate-only client for Kraken AddOrder. It can check an order but cannot place one:
// - assertValidateOnly runs before anything is sent.
// - If Kraken ever returns a transaction id (txid), the call throws, because that means an order was created.
// Uses a separate trading key (KRAKEN_TRADE_API_KEY / KRAKEN_TRADE_API_SECRET), never the read-only key.

import { signKrakenRequest, KRAKEN } from "../worker/src/index.js";
import { assertValidateOnly } from "./order.mjs";

export async function validateOrder({ params, nonce, env, fetchImpl = globalThis.fetch }) {
  assertValidateOnly(params);
  if (!env.KRAKEN_TRADE_API_KEY || !env.KRAKEN_TRADE_API_SECRET) {
    throw new Error("trading key is not configured");
  }
  const path = "/0/private/AddOrder";
  const body = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
  const sign = await signKrakenRequest(path, body, String(nonce), env.KRAKEN_TRADE_API_SECRET);

  const res = await fetchImpl(`${KRAKEN}${path}`, {
    method: "POST",
    headers: {
      "API-Key": env.KRAKEN_TRADE_API_KEY,
      "API-Sign": sign,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json().catch(() => ({ error: ["invalid response from Kraken"] }));
  if (json.error && json.error.length) throw new Error(json.error.join("; "));

  const result = json.result || {};
  if (result.txid) {
    // A txid means an order was created. This must never happen during validation.
    throw new Error("unexpected txid in validate response: an order may have been placed. Halt and investigate.");
  }
  return { description: result.descr?.order || null };
}
