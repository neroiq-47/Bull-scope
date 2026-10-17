#!/usr/bin/env node
// Bull-Scope LLM reviewer (paper only).
// Fetches the rule-based signal from the Worker, asks a local model to keep or veto each proposal,
// and appends the decision to a local journal. It never calls Kraken and never places orders.
//
// Usage:
//   SIGNAL_URL=https://<your-worker>/v1/signal/btc-gbp node agent/run.mjs
//   SIGNAL_URL=... node agent/run.mjs --loop 300     # re-check every 300 seconds
//
// Environment:
//   SIGNAL_URL     required, the Worker signal endpoint
//   LLM_BASE_URL   optional, default http://localhost:11434/v1 (Ollama)
//   LLM_MODEL      optional, default llama3.2:3b

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLlmClient, LLM_DEFAULTS } from "./llm.mjs";
import { reviewSignal } from "./review.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const JOURNAL_PATH = join(here, "journal.jsonl");

export async function fetchSignal(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`signal request failed (${res.status})`);
  return res.json();
}

export function appendJournal(entry, path = JOURNAL_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export async function runOnce({ signalUrl, llm, journalPath = JOURNAL_PATH, now = Date.now() }) {
  const signal = await fetchSignal(signalUrl);
  const result = await reviewSignal({ signal, llm, now });
  const entry = {
    at: result.at,
    model: llm.model,
    rejectedReason: signal.rejectedReason ?? null,
    reviewed: result.reviewed.map((r) => ({
      proposal: r.proposal,
      verdict: r.decision.verdict,
      confidence: r.decision.confidence,
      reason: r.decision.reason,
      source: r.decision.source,
    })),
    shownToHuman: result.shown.length,
  };
  appendJournal(entry, journalPath);
  return entry;
}

function printEntry(entry) {
  console.log(`[${entry.at}] model=${entry.model}`);
  if (entry.reviewed.length === 0) {
    console.log(`  no proposals (${entry.rejectedReason || "no signal"})`);
    return;
  }
  for (const r of entry.reviewed) {
    console.log(`  ${r.verdict.toUpperCase()} (${r.source}, confidence ${r.confidence}): ${r.reason}`);
    console.log(`    entry ${r.proposal.entry} · stop ${r.proposal.stop} · target ${r.proposal.target}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const loopIdx = args.indexOf("--loop");
  const loopSeconds = loopIdx >= 0 ? Number(args[loopIdx + 1]) : null;
  const signalUrl = process.env.SIGNAL_URL;
  if (!signalUrl) {
    console.error("Set SIGNAL_URL to your Worker signal endpoint, e.g. https://<worker>/v1/signal/btc-gbp");
    process.exit(1);
  }
  const llm = createLlmClient({
    baseUrl: process.env.LLM_BASE_URL || LLM_DEFAULTS.baseUrl,
    model: process.env.LLM_MODEL || LLM_DEFAULTS.model,
  });

  const tick = async () => {
    try {
      printEntry(await runOnce({ signalUrl, llm }));
    } catch (err) {
      console.error(`run failed: ${err.message}. Nothing was approved.`);
    }
  };

  await tick();
  if (loopSeconds && loopSeconds > 0) setInterval(tick, loopSeconds * 1000);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
