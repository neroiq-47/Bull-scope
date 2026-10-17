# Executor status

This records what is built toward the trading plan in `TRADING-PLAN.md`, and what is deliberately not built.

## Built (inert: nothing here can place a live order)

| File | Purpose |
|---|---|
| `executor/limits.mjs` | Pre-trade checks: Kraken minimums (never rounded up), position and order limits, daily and total loss stops, price deviation, candle age, expiry, reward-to-risk. |
| `executor/safety.mjs` | Kill switch (environment flag or halt file) and single-use, expiring, proposal-bound approval tokens. |
| `executor/order.mjs` | Builds AddOrder parameters. Every request carries `validate=true`. |
| `executor/validate.mjs` | Validate-only client. It refuses any request without `validate=true`, and throws if Kraken ever returns a transaction id. |
| `executor/reconcile.mjs` | Compares the local intent log with Kraken's open orders and flags any mismatch. |

| `executor/pipeline.mjs` | Dry run: combines the kill switch, pre-trade checks and single-use approval, then returns `ready` with a validate-only request or `blocked` with reasons. It never sends anything. |
| `worker/src/index.js` → `/v1/market/pair-limits` | Public AssetPairs minimums for `XBTGBP`. Field names are unverified against Kraken's reference, and a missing field is an error. |

Tests: `test/executor.test.mjs` and `test/drills.test.mjs` (scripted kill-switch, approval-replay, loss-stop and reconciliation drills). Run `npm test`: 79 passing.

## Audit fixes (latest pass)

- Order prices round down to the pair's tick size, and volumes round down to lot precision. Previously prices were hard-coded to two decimals and volume was rounded, which could exceed the risk budget.
- A size that falls below the Kraken minimum after rounding is refused.
- Pair limits must include tick size and lot decimals. Missing values refuse rather than fall back to defaults.
- Approval tokens must have exactly two segments. Used-token records persist to disk, so a restart cannot replay a token.
- Strategy sizing now honours the strategy config passed in, rather than silently using defaults.
- Public Kraken market data is cached for 10 seconds, so polling dashboards cannot exhaust the public rate limit.
- Signals report the close time of the newest closed candle. The dashboard refuses to show proposals built on data older than 10 minutes.
- Balance parsing tolerates an empty Kraken result.
- The agent CLI has a 15-second timeout on the signal fetch and does not start a second review while one is running.

## Known gaps still open

- The backtest omits any trade still open when the data ends. Report it or close it at the last bar.
- Expired proposals are still sent to the reviewer, which wastes a model call.
- No approval interface issues tokens yet.
- Pair-limit field names are unverified against Kraken's reference page.

## Not built, on purpose

- **Live order submission.** There is no function that sends an order without `validate=true`. This stays out of the code until every Stage 0 gate in `TRADING-PLAN.md` is met and you decide to proceed.
- **Stage 3 (unattended automation).** Not built. The plan recommends deciding it only after Stage 2 has succeeded.
- **Exchange-side stop-loss orders.** Kraken's AddOrder documentation lists `stop-loss` and `stop-loss-limit` order types (the `price` field is the trigger price, and `price2` is the limit price for the limit variant). Whether `XBTGBP` accepts these types is still unverified. Check the pair's available order types from the AssetPairs endpoint before relying on them.
- **Order-state tracking after submission.** Needed for Stage 2 and depends on the submission path above.
- **The approval interface.** `createApproval` exists, but nothing calls it yet. The dashboard does not yet issue tokens.
- **Live submission function.** Deliberately absent. `prepareOrder` returns the validate-only request, and a later, explicitly enabled function would send it. That function is not written.
- **Runtime stop-loss check.** Kraken's documentation lists stop-loss order types, but the pair-limits route does not yet report which order types `XBTGBP` accepts.
- **Pair-limit field names.** `ordermin`, `costmin`, `tick_size` and `lot_decimals` are unverified against Kraken's reference page. Confirm them against a live response before relying on them.
- **Stage 0 items.** Backtest on real candles, verified fee tier, paper track record, independent review and tax check all need your data and actions, not code.

## Before Stage 2 can be enabled

1. Complete every Stage 0 item in `TRADING-PLAN.md`.
2. Create a trading key with order permissions only, separate from the read-only key, and restricted by IP where Kraken allows it.
3. Verify the exchange-side stop behaviour for `XBTGBP`.
4. Add the submission path, with tests that confirm it cannot be reached without a valid approval token and a passing pre-trade check.
5. Run the kill-switch drill and the reconciliation drill, and record the results.
