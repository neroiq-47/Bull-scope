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

Tests: `test/executor.test.mjs`. Run `npm test`. There are 62 passing tests in total.

## Not built, on purpose

- **Live order submission.** There is no function that sends an order without `validate=true`. This stays out of the code until every Stage 0 gate in `TRADING-PLAN.md` is met and you decide to proceed.
- **Stage 3 (unattended automation).** Not built. The plan recommends deciding it only after Stage 2 has succeeded.
- **Exchange-side stop-loss orders.** Kraken's AddOrder documentation lists `stop-loss` and `stop-loss-limit` order types (the `price` field is the trigger price, and `price2` is the limit price for the limit variant). Whether `XBTGBP` accepts these types is still unverified. Check the pair's available order types from the AssetPairs endpoint before relying on them.
- **Order-state tracking after submission.** Needed for Stage 2 and depends on the submission path above.
- **The approval interface.** `createApproval` exists, but nothing calls it yet. The dashboard does not yet issue tokens.

## Before Stage 2 can be enabled

1. Complete every Stage 0 item in `TRADING-PLAN.md`.
2. Create a trading key with order permissions only, separate from the read-only key, and restricted by IP where Kraken allows it.
3. Verify the exchange-side stop behaviour for `XBTGBP`.
4. Add the submission path, with tests that confirm it cannot be reached without a valid approval token and a passing pre-trade check.
5. Run the kill-switch drill and the reconciliation drill, and record the results.
