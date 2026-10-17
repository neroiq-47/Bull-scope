# Bull-Scope

A paper-first, manual-approval dashboard for a £100 Kraken BTC/GBP spot micro-swing strategy.

## What it does

- Live BTC/GBP price from Kraken's public ticker.
- Signal status: 15-minute trend and 5-minute pullback, evaluated on closed candles only.
- Approval cards for long-only **paper** trades: entry, stop, target, position size, risk, estimated fees and expiry.
- Fee gate: a proposal is shown only if it still has at least 1.0R reward-to-risk after estimated fees.
- Read-only Kraken balances (Query Funds permission only), valued in GBP where the price is known.
- Funds page with links to Kraken's own deposit flows and a withdrawal fee preview marked **unverified**.
- Historical replay tool for your own candle data.

## What it deliberately does not do

- No live orders, no leverage, no shorting, no withdrawal execution.
- No card details, bank credentials, exchange passwords or API secrets are collected in the browser.
- Approving a trade records a simulated position in your browser only.

## Layout

```
index.html            Dashboard, Trades, Funds, Connect views
styles.css            Mobile-first styles, dark theme, reduced-motion support
app.js                Browser logic: routing, price, signals, approvals, previews
js/strategy.js        Shared pure logic: EMA, signal rules, fee-aware sizing, fee gate
js/config.js          API_BASE: set this to your deployed Worker URL
_headers              Security headers and CSP for Cloudflare Pages (edit the Worker host)
worker/src/index.js   Server component: holds the read-only key, exposes read-only routes
worker/wrangler.toml  Worker config (ALLOWED_ORIGINS, no secrets)
tools/backtest.mjs    Historical replay on CSV candles you supply (analysis only)
test/                 Unit and integration tests (node:test)
```

## Run the tests

Requires Node 20 or later. No dependencies to install.

```bash
npm test
```

The tests cover the strategy maths, fee gate, Kraken request signing (checked against an independent HMAC computation), CORS, error mapping, secret non-leakage, and the backtest engine. The test fixtures are synthetic and exist only to check logic.

## Historical replay

Export closed Kraken OHLC candles for `XBTGBP` at 5 and 15 minutes from your own source, then:

```bash
node tools/backtest.mjs --c5 path/to/5m.csv --c15 path/to/15m.csv
```

Assumptions: fills at the signal candle close, no slippage, stop checked before target within a bar, fees at the placeholder rate, 48-bar timeout. The output is a historical simulation, not a forecast. No candle data is included in this project.

## Set up the read-only Kraken key

1. Sign in at kraken.com directly.
2. Settings → API → create a new key.
3. Tick **Query Funds** only. Leave everything else off.
4. If offered, restrict the key by IP to your Worker's egress, where Kraken allows it.
5. Copy the key and secret once. Do not paste them anywhere in this website.

## Deploy the server component

```bash
cd worker
npx wrangler login
npx wrangler secret put KRAKEN_API_KEY
npx wrangler secret put KRAKEN_API_SECRET
# set ALLOWED_ORIGINS in wrangler.toml to your site's origin, e.g. https://bull-scope.example.com
npx wrangler deploy
```

Then:

1. Set `API_BASE` in `js/config.js` to the Worker URL.
2. In `_headers`, replace `REPLACE-WITH-WORKER-HOST` with the Worker host. Without this the browser blocks all API calls.
3. Serve the front end from a static host such as Cloudflare Pages.

## Fee estimate and the fee gate: what the numbers show

The placeholder taker fee is 0.40% per side. Round-trip cost is therefore about 0.8% of the position. For a 2R target, the stop has to sit roughly **1.6% or more** below entry before the trade pays after estimated fees. Tests confirm that a 1.4% stop does not pay and a 1.8% stop does.

A micro-swing with a tight stop will therefore often be rejected by the fee gate. That is the intended behaviour: the app refuses to show a plan that loses money after fees. If you want more proposals, the levers are a lower verified fee tier, a maker-fee strategy (which needs a different order type than this app supports), or a different target multiple. Each changes the economics, so backtest before changing them.

## Cost ceiling

The stack is designed for the £25/month infrastructure ceiling: static hosting plus one Worker, with no database, no cron jobs and no paid data feeds. Confirm current Cloudflare and Kraken pricing before relying on this. The app does not check billing.

## Fees and withdrawals

- Trading fees depend on your Kraken volume tier and whether you add or take liquidity. Check your live tier and update `takerFeeRate` in `js/strategy.js` when you have verified it.
- Withdrawal fees are shown as **unverified** until checked against Kraken's live GBP quote for the selected method. Never treat a withdrawal as fee-free unless that quote confirms zero fees and the method is eligible.
- Deposits and withdrawals can take time and may carry bank or Kraken charges.

## Operational notes

- Kraken requires strictly increasing nonces per key. The Worker keeps a counter per isolate, but Cloudflare can run several isolates at once. If you see "Invalid nonce" errors under load, keep the Worker's traffic low (the dashboard polls every 15 seconds) or move the nonce to a shared store.
- Paper trades live in the browser's localStorage. They are per browser and not synced. The unrealised figure is an estimate that uses the last ticker price, not a fill.
- Signals and proposals are calculated on each request from the latest closed candles. The expiry on a proposal is 30 minutes after its signal candle closes.

## Still needed before any real capital is considered

- Backtest the rules on your own historical candles using `tools/backtest.mjs`, including out-of-sample periods, and review the trade count, drawdown and fee drag.
- Verify your live Kraken fee tier and update the placeholder.
- Verify GBP withdrawal fees for each method you intend to use.
- Decide on durable storage if you want history across devices.
- Get an independent review of the signal and fee logic.

## Disclaimer

This is a tool for learning and paper trading, not financial advice. Crypto is volatile and you can lose the money you put in.
