// Veto-only review of rule-generated proposals.
// The model can answer "keep" or "veto" for each proposal. It cannot create proposals or change
// entry, stop, target or size. Anything malformed or unavailable fails closed (vetoed).

import { computePlan, round2 } from "../js/strategy.js";

export const VERDICTS = Object.freeze(["keep", "veto"]);
export const MAX_REASON_LENGTH = 200;
const ALLOWED_KEYS = new Set(["verdict", "confidence", "reason"]);

export const SYSTEM_PROMPT = [
  "You review one paper-trade proposal produced by fixed rules for a long-only BTC/GBP spot strategy.",
  "You may only keep or veto it. You cannot change the entry, stop, target or size, and you cannot propose a new trade.",
  "Veto when the facts show a weak setup, such as a stop that barely pays after fees, a trend that is marginal, or a proposal near expiry.",
  "Keep when the facts look sound. Be conservative.",
  'Reply with only a JSON object: {"verdict": "keep" or "veto", "confidence": a number from 0 to 1, "reason": a string under 200 characters}.',
].join(" ");

/**
 * Facts the model sees. Only numbers and fixed signal text, so there is no free-form input to inject into.
 */
export function buildSnapshot(signal, now = Date.now()) {
  return {
    trend15m: signal.trend15m,
    trend15mText: String(signal.trend15mText || ""),
    pullback5mText: String(signal.pullback5mText || ""),
    proposals: (signal.proposals || []).map((p) => {
      const plan = computePlan({ entry: p.entry, stop: p.stop, target: p.target });
      return {
        entry: p.entry,
        stop: p.stop,
        target: p.target,
        stopDistancePct: round2(((p.entry - p.stop) / p.entry) * 100),
        estimatedFeesGbp: plan ? round2(plan.feesGbp) : null,
        netRewardRatio: plan ? round2(plan.netRewardRatio) : null,
        minutesToExpiry: Math.max(0, Math.round((Date.parse(p.expiresAt) - now) / 60000)),
      };
    }),
  };
}

/**
 * Strict validation of model output. Extra keys, wrong types or unknown verdicts throw.
 */
export function parseVerdict(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("verdict is not an object");
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unexpected key: ${key}`);
  }
  if (!VERDICTS.includes(obj.verdict)) throw new Error("verdict must be keep or veto");
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) throw new Error("reason is required");
  if (obj.reason.length > MAX_REASON_LENGTH) throw new Error("reason is too long");
  return { verdict: obj.verdict, confidence: obj.confidence, reason: obj.reason.trim() };
}

/**
 * Review a single proposal. Never throws: any failure becomes a fail-closed veto.
 */
export async function reviewProposal({ llm, snapshot }) {
  try {
    const raw = await llm.chatJson([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(snapshot) },
    ]);
    return { ...parseVerdict(raw), source: "llm" };
  } catch (err) {
    return {
      verdict: "veto",
      confidence: 0,
      reason: `Blocked (fail-closed): ${err.message}`,
      source: "fail-closed",
    };
  }
}

/**
 * Review every rule-generated proposal in a signal. Returns the proposals with their verdicts.
 * The rule-generated levels pass through unchanged, and no LLM call is made when there are no proposals.
 */
export async function reviewSignal({ signal, llm, now = Date.now() }) {
  const proposals = signal.proposals || [];
  if (proposals.length === 0) {
    return { at: new Date(now).toISOString(), reviewed: [], shown: [] };
  }
  const snapshot = buildSnapshot(signal, now);
  const reviewed = [];
  for (let i = 0; i < proposals.length; i++) {
    const decision = await reviewProposal({ llm, snapshot: { ...snapshot, proposal: snapshot.proposals[i] } });
    reviewed.push({ proposal: proposals[i], decision });
  }
  return {
    at: new Date(now).toISOString(),
    reviewed,
    shown: reviewed.filter((r) => r.decision.verdict === "keep").map((r) => r.proposal),
  };
}
