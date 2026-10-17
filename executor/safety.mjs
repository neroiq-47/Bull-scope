// Kill switch and single-use approval tokens.
// Both are designed to work without the dashboard, the model or the browser.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Halted if either the environment flag or the halt file is present.
 * fileExists is injected so the check can be tested without touching disk.
 */
export function isHalted({ env = {}, haltFile = null, fileExists = () => false }) {
  if (env.BULL_SCOPE_HALT === "1") return { halted: true, reason: "BULL_SCOPE_HALT=1" };
  if (haltFile && fileExists(haltFile)) return { halted: true, reason: `halt file present: ${haltFile}` };
  return { halted: false, reason: null };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Create a short-lived approval token for one proposal. The human approval UI would call this.
 */
export function createApproval({ proposalId, secret, nowSeconds, ttlSeconds = 300, nonce = randomBytes(12).toString("hex") }) {
  if (!secret || secret.length < 32) throw new Error("approval secret must be at least 32 characters");
  const payload = b64url(JSON.stringify({ id: proposalId, exp: nowSeconds + ttlSeconds, nonce }));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Verify a token. Tokens are single-use: the caller passes a Set of consumed nonces, and a used nonce is refused.
 * Returns { ok, reason, proposalId } and records the nonce as consumed on success.
 */
export function verifyApproval({ token, secret, proposalId, nowSeconds, consumed }) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "malformed token" };
  const [payload, sig] = token.split(".");
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "unreadable payload" }; }

  if (data.id !== proposalId) return { ok: false, reason: "token is for a different proposal" };
  if (!(data.exp > nowSeconds)) return { ok: false, reason: "token expired" };
  if (consumed.has(data.nonce)) return { ok: false, reason: "token already used" };

  consumed.add(data.nonce);
  return { ok: true, reason: null, proposalId: data.id };
}
