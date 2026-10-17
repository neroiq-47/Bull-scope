// Builds AddOrder parameters and validates them. There is NO submission function in this module or anywhere in the project.
// Every request built here carries validate=true, so Kraken checks it without placing an order.

export const PAIR = "XBTGBP";

// Round DOWN to a step. A buy must never exceed the risk budget or the signal price.
export function floorTo(value, step) {
  return Math.floor(value / step + 1e-9) * step;
}

function decimalsOf(step) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

// Kraken's userref is an integer. Derive a stable one from the intent id so reconciliation can match orders.
export function userrefFor(intentId) {
  let h = 0;
  for (const ch of String(intentId)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) || 1;
}

/**
 * Build a validate-only limit buy. Post-only, GTD, so an unfilled order expires.
 */
export function buildValidateOrder({ intentId, volumeBase, limitPrice, expireAtSeconds, tickSize, lotDecimals }) {
  if (!(volumeBase > 0) || !(limitPrice > 0)) throw new Error("volume and price must be positive");
  if (!(tickSize > 0) || !Number.isInteger(lotDecimals) || lotDecimals < 0) {
    throw new Error("tick size and lot decimals are required from the pair's limits");
  }
  if (!Number.isInteger(expireAtSeconds)) throw new Error("expireAtSeconds must be an integer timestamp");
  return {
    pair: PAIR,
    type: "buy",
    ordertype: "limit",
    volume: floorTo(volumeBase, 10 ** -lotDecimals).toFixed(lotDecimals),
    price: floorTo(limitPrice, tickSize).toFixed(decimalsOf(tickSize)),
    timeinforce: "GTD",
    expiretm: String(expireAtSeconds),
    oflags: "post",
    userref: String(userrefFor(intentId)),
    validate: "true",
  };
}

/**
 * Refuse any parameter set that would place a live order.
 */
export function assertValidateOnly(params) {
  if (params.validate !== "true") {
    throw new Error("refusing: AddOrder must carry validate=true. Kraken treats an unset flag as a live order.");
  }
  return params;
}
