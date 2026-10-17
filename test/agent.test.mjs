import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmClient } from "../agent/llm.mjs";
import { buildSnapshot, parseVerdict, reviewSignal, reviewProposal } from "../agent/review.mjs";
import { runOnce } from "../agent/run.mjs";

const proposal = { id: "p-1", entry: 100000, stop: 97000, target: 106000, expiresAt: new Date(Date.now() + 25 * 60000).toISOString() };
const signal = { trend15m: "up", trend15mText: "EMA20 above EMA50", pullback5mText: "Dip then reclaim", rejectedReason: null, proposals: [proposal] };

const fakeLlm = (reply) => ({ model: "fake", chatJson: async () => (reply instanceof Error ? Promise.reject(reply) : reply) });

test("parseVerdict accepts a well-formed verdict", () => {
  const v = parseVerdict({ verdict: "keep", confidence: 0.7, reason: "  fine  " });
  assert.deepEqual(v, { verdict: "keep", confidence: 0.7, reason: "fine" });
});

test("parseVerdict rejects extra keys such as a trade action", () => {
  assert.throws(() => parseVerdict({ verdict: "keep", confidence: 0.5, reason: "x", action: "buy" }), /unexpected key/);
});

test("parseVerdict rejects unknown verdicts, bad confidence and long reasons", () => {
  assert.throws(() => parseVerdict({ verdict: "buy", confidence: 0.5, reason: "x" }));
  assert.throws(() => parseVerdict({ verdict: "keep", confidence: 2, reason: "x" }));
  assert.throws(() => parseVerdict({ verdict: "keep", confidence: 0.5, reason: "x".repeat(201) }));
  assert.throws(() => parseVerdict({ verdict: "keep", confidence: 0.5, reason: "   " }));
});

test("a model error fails closed to a veto", async () => {
  const d = await reviewProposal({ llm: fakeLlm(new Error("timeout")), snapshot: {} });
  assert.equal(d.verdict, "veto");
  assert.equal(d.source, "fail-closed");
});

test("malformed model output fails closed to a veto", async () => {
  const d = await reviewProposal({ llm: fakeLlm({ verdict: "keep", confidence: 0.9, reason: "ok", extra: 1 }), snapshot: {} });
  assert.equal(d.verdict, "veto");
});

test("no proposals means no model call", async () => {
  let called = false;
  const llm = { model: "fake", chatJson: async () => { called = true; return {}; } };
  const r = await reviewSignal({ signal: { ...signal, proposals: [] }, llm });
  assert.equal(called, false);
  assert.deepEqual(r.shown, []);
});

test("a keep verdict passes the rule-generated levels through unchanged", async () => {
  const r = await reviewSignal({ signal, llm: fakeLlm({ verdict: "keep", confidence: 0.6, reason: "sound" }) });
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0], proposal, "the same object reaches the human, untouched");
});

test("a veto removes the proposal from what the human sees", async () => {
  const r = await reviewSignal({ signal, llm: fakeLlm({ verdict: "veto", confidence: 0.8, reason: "fees too high" }) });
  assert.equal(r.shown.length, 0);
  assert.equal(r.reviewed[0].decision.verdict, "veto");
});

test("the snapshot exposes numbers and the fee-aware reward ratio", () => {
  const snap = buildSnapshot(signal, Date.now());
  assert.equal(snap.proposals[0].stopDistancePct, 3);
  assert.ok(snap.proposals[0].netRewardRatio >= 1);
  assert.ok(snap.proposals[0].minutesToExpiry > 0);
});

test("createLlmClient posts to the chat endpoint with JSON mode and parses the reply", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"keep","confidence":0.5,"reason":"ok"}' } }] }), { status: 200 });
  };
  const llm = createLlmClient({ baseUrl: "http://localhost:11434/v1/", model: "m", fetchImpl });
  const out = await llm.chatJson([{ role: "user", content: "hi" }]);
  assert.equal(seen.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.temperature, 0);
  assert.deepEqual(seen.body.response_format, { type: "json_object" });
  assert.equal(out.verdict, "keep");
});

test("createLlmClient throws on a non-OK HTTP status", async () => {
  const llm = createLlmClient({ fetchImpl: async () => new Response("no", { status: 500 }) });
  await assert.rejects(() => llm.chatJson([]), /LLM HTTP 500/);
});

test("runOnce writes a journal line and still vetoes when the model is down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bull-scope-journal-"));
  const journalPath = join(dir, "journal.jsonl");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(signal), { status: 200 });
    const llm = fakeLlm(new Error("connection refused"));
    const entry = await runOnce({ signalUrl: "https://worker.test/v1/signal/btc-gbp", llm, journalPath });
    assert.equal(entry.shownToHuman, 0);
    assert.equal(entry.reviewed[0].verdict, "veto");
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).reviewed[0].source, "fail-closed");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
