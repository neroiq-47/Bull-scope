# Bull-Scope trading ability: staged plan

Status: **planning only.** The project is paper-only today. Nothing in this document authorises live orders. Your original brief excluded automatic live orders from the initial version, so moving past Stage 1 is a decision for you, taken only when the gates below are met.

## Principles

1. **The rules propose, the model only reviews, a human approves, and an executor with hard limits is the only thing that can send an order.** The LLM never gets execution rights.
2. **Every stage has a kill switch and a loss limit that work without the model, the dashboard or the internet connection to the browser.**
3. **Advance a stage only on evidence.** Each stage has entry and exit criteria, and failing them means stopping.
4. **Fail closed.** Missing data, stale candles, an unknown order state or a failed reconciliation means no new orders.

## Kraken facts this plan relies on

Verified from Kraken's documentation and support pages during planning:

- **AddOrder `validate` defaults to `false`.** Without `validate=true` a request places a real order. The executor must set this flag explicitly and must test with it set.
- With `validate=true` the request is only checked and is not sent to the matching engine. This is the dry-run mechanism.
- **Post-only** (`oflags=post`) is available only for limit orders. It avoids taker fees but the order may not fill.
- **Minimum order size** is 0.0001 BTC, and Kraken's support page lists a 5 GBP minimum for trading. Kraken states it cannot make exceptions. At a £100 allocation, the 1% risk sizing can produce an order below the minimum, which must be treated as "no trade", not rounded up.
- Minimums and precision change. The executor must read current pair limits from the AssetPairs endpoint at runtime, not from hard-coded values.

Not yet verified (must check before Stage 2): whether Kraken offers exchange-side stop-loss orders for `XBTGBP` with the account's order types, and what fees apply to your tier.

## Stage 0: prerequisites (all required before any live key is created)

- [ ] Backtest on at least two years of closed 5-minute and 15-minute `XBTGBP` candles, with a held-out period the rules were not tuned on. Report trade count, win rate, average R after fees, maximum drawdown and fee drag.
- [ ] Verified Kraken fee tier. The 0.40% placeholder is replaced with the real figure in `js/strategy.js`, and the backtest is re-run.
- [ ] At least 3 months and at least 50 paper trades, with the reviewer on and off, so you can see whether it helps.
- [ ] An independent review of the signal, fee and sizing logic.
- [ ] A written loss budget you accept, for example "I can lose the £100 allocation without it affecting me."
- [ ] A tax and regulatory check for your situation. The UK rules for crypto are changing. Speak to an adviser before trading live. This project does not provide that advice.

## Stage 1: paper (current)

- Rules generate proposals, the optional reviewer keeps or vetoes them, and the human approves on paper.
- Exit criteria: Stage 0 complete.

## Stage 2: assisted live (human approves every order)

Each order requires a human click on a proposal. The executor does not send anything without that click.

**Keys and access**

- A **separate trading key** with only the order permissions it needs (create, modify, cancel). No withdrawal and no deposit permission, and never the read-only key. Restrict by IP if Kraken allows it.
- The trading key lives in the executor's secrets store, not in the browser and not in the read-only Worker.

**Executor (a separate service, not the existing read-only Worker)**

- Accepts only an order request signed by the rules engine and carrying a one-time human approval token. Tokens expire in minutes and are single-use.
- Runs a **dry run first:** every order is sent with `validate=true` and the response is checked before the real request is made.
- Sets `userref` on every order for idempotency and reconciliation. Each request is logged before it is sent.
- Reads pair minimums and precision at runtime. If sizing falls below a minimum, the order is refused, not rounded.

**Hard limits (enforced in code, not in prompts)**

| Control | Starting value | Notes |
|---|---|---|
| Max position | 95% of allocation (current cap) | from `js/strategy.js` |
| Risk per trade | 1% of allocation | from `js/strategy.js` |
| Max open positions | 1 | |
| Max orders per day | 2 | |
| Daily loss stop | 2% of allocation | no new orders after breach until next day and manual review |
| Total loss stop | 10% of allocation | halts live trading until manual review |
| Order expiry | 30 minutes | cancel unfilled limit orders |
| Price deviation | limit must be within 0.3% of the signal price | refuse if the market has moved |
| Candle age | signal candles must be closed and under 10 minutes old | refuse stale data |

Values are starting points. Change them only with a documented reason.

**Kill switch**

- A kill-switch file and an environment flag. Either one stops new orders.
- A command that cancels all open orders on the exchange.
- The kill switch must work with the dashboard and the model offline.

**Reconciliation**

- Every cycle, the executor compares its own order log with Kraken's open orders and balances. Any mismatch halts trading and raises an alert.

**Stops**

- In Stage 2 the stop must exist on the exchange, not only in software. A software-only stop fails if the executor, the network or the exchange is unreachable at the moment price falls. Use an exchange stop-loss order if Kraken supports it for this pair (to verify), and accept that a stop-limit order can fail to fill in a fast move.

**Exit criteria to Stage 3**

- At least 30 live trades over at least 2 months, all within the limits above.
- Live results within the range predicted by the paper and backtest results. A large gap means stop and investigate.
- No unreconciled orders, no executor errors left unexplained, and the kill switch tested in a drill.

## Stage 3: constrained automation (optional, not recommended until Stage 2 succeeds)

- The executor places orders that match a rule-generated proposal with no per-order click, only inside the Stage 2 limits.
- Still no withdrawal permission, still no leverage, still no shorting.
- Any limit change requires a human edit with a recorded reason.

Stage 3 is not part of this plan's commitment. Decide it separately, after Stage 2 results.

## Testing

- Unit tests for sizing against minimums, the daily and total loss stops, expiry, price deviation and stale-candle refusal.
- Integration test: every order path goes through `validate=true` in automated tests. A test that would send a live order without the flag must fail.
- Kraken documentation does not describe a sandbox environment in the pages reviewed, so do not assume one exists. Test against live `validate=true` only.
- Fault injection: network drop after an order is sent, duplicate response, unknown order state. Each must halt trading until reconciled.

## Explicitly out of scope

- Leverage, margin, shorting, derivatives or futures.
- Withdrawals of any kind.
- Market orders in Stage 2 (limit orders only, to bound slippage).
- LLM-generated trade levels or sizes.
- Multiple pairs. `XBTGBP` only.

## Open decisions for you

1. Confirm you want to move beyond Stage 1 at all, given the original brief excluded live orders from the initial version.
2. Choose the loss budget (the starting values above assume a £100 allocation).
3. Confirm who else would have access to the trading key and the kill switch.
4. Confirm the tax and regulatory advice you will take before Stage 2.
