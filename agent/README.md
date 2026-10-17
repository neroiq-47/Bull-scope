# Bull-Scope LLM reviewer (paper only)

A small local model reviews the rule-based trade proposals. It can **keep or veto** them. It cannot create trades, change entry, stop, target or size, and it cannot place orders. Nothing here calls Kraken.

## Design limits

- The rules generate every proposal. The model only filters them.
- Malformed output, a timeout, an unreachable model or an unexpected field all **fail closed**: the proposal is blocked.
- Each decision is appended to `agent/journal.jsonl` so you can measure whether the reviewer helps.
- Language models are not reliable price forecasters. Treat the reviewer as a filter to test, not a source of edge. Compare journal outcomes against the rules alone before trusting it.

## Set up a local model

1. Install [Ollama](https://ollama.com).
2. Pull a small model. The default is `llama3.2:3b`:
   ```bash
   ollama pull llama3.2:3b
   ollama list    # check the SIZE column fits your 4GB budget with room for the OS
   ```
   If it is too large, try another model of similar size and set `LLM_MODEL`.

## Run

```bash
SIGNAL_URL=https://<your-worker>/v1/signal/btc-gbp node agent/run.mjs
SIGNAL_URL=https://<your-worker>/v1/signal/btc-gbp node agent/run.mjs --loop 300
```

Optional: `LLM_BASE_URL` (default `http://localhost:11434/v1`) and `LLM_MODEL` (default `llama3.2:3b`).

## Test

```bash
npm test
```

The agent tests use a fake model client. They check the fail-closed behaviour, strict output validation, that levels pass through unchanged, and that no model call is made when there are no proposals.

## What is not built

- No live execution path. This is intentional.
- The snapshot holds only the signal facts (trend, pullback, levels, fee estimate). It does not include raw candles, so the model cannot reason about price history beyond those facts.
- The model's confidence is self-reported and not calibrated.
