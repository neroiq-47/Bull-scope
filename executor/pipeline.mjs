// Dry-run order pipeline. It decides whether a proposal would be ready for submission and builds the
// validate-only request. It NEVER sends anything: there is no submit call in this module.
//
// Stage 2 submission, once the Stage 0 gates are met, would take the `ready` result below and send it
// through a separate, explicitly enabled function. That function is intentionally not written yet.

import { checkPreTrade } from "./limits.mjs";
import { isHalted, verifyApproval } from "./safety.mjs";
import { buildValidateOrder, assertValidateOnly, floorTo } from "./order.mjs";

/**
 * @returns {{ status: "blocked"|"ready", reasons: string[], params: object|null }}
 */
export function prepareOrder({
  proposal,
  plan,
  market,
  state,
  pairLimits,
  nowSeconds,
  intentId,
  approval,      // { token, secret, consumed } from the human approval step
  halt,          // { env, haltFile, fileExists }
}) {
  const reasons = [];

  const halted = isHalted(halt || {});
  if (halted.halted) reasons.push(`halted: ${halted.reason}`);

  const pre = checkPreTrade({ proposal, plan, market, state, pairLimits, nowSeconds });
  reasons.push(...pre.reasons);

  if (!approval || !approval.token) {
    reasons.push("no human approval token");
  } else {
    const v = verifyApproval({
      token: approval.token,
      secret: approval.secret,
      proposalId: proposal.id,
      nowSeconds,
      consumed: approval.consumed,
    });
    if (!v.ok) reasons.push(`approval rejected: ${v.reason}`);
  }

  // Rounding the size down to the pair's lot precision can drop it below the minimum. Re-check after rounding.
  if (reasons.length === 0 && plan && pairLimits && Number.isInteger(pairLimits.lotDecimals)) {
    const volume = floorTo(plan.qty, 10 ** -pairLimits.lotDecimals);
    if (volume < pairLimits.minVolumeBase) {
      reasons.push("size after rounding down to lot precision is below the Kraken minimum");
    }
  }

  if (reasons.length > 0) return { status: "blocked", reasons, params: null };

  // Only reached when every check passes. The request is validate-only by construction.
  const params = assertValidateOnly(
    buildValidateOrder({
      intentId,
      volumeBase: plan.qty,
      limitPrice: proposal.entry,
      expireAtSeconds: Math.floor(Date.parse(proposal.expiresAt) / 1000),
      tickSize: pairLimits.tickSize,
      lotDecimals: pairLimits.lotDecimals,
    }),
  );
  return { status: "ready", reasons: [], params };
}
