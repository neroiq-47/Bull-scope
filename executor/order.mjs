// Builds AddOrder parameters and validates them. There is NO submission function in this module or anywhere in the project.
// Every request built here carries validate=true, so Kraken checks it without placing an order.

export const PAIR = "XBTGBP";

// Kraken's userref is an integer. Derive a stable one from the intent id so reconciliation can match orders.
export function userrefFor(intentId) {
  let h = 0;
  for (const ch of String(intentId)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) || 1;
}

/**
 * Build a validate-only limit buy. Post-only, GTD, so an unfilled order expires.
 */
export function buildValidateOrder({ intentId, volumeBase, limitPrice, expireAtSeconds }) {
  if (!(volumeBase > 0) || !(limitPrice > 0)) throw new Error("volume and price must be positive");
  if (!Number.isInteger(expireAtSeconds)) throw new Error("expireAtSeconds must be an integer timestamp");
  return {
    pair: PAIR,
    type: "buy",
    ordertype: "limit",
    volume: volumeBase.toFixed(8),
    price: limitPrice.toFixed(2),
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
