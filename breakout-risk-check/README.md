# Breakout Risk Check — TradingView alert prototype

Deployed at https://breakout-risk-check.atmamont.workers.dev/. Branch: `feature/breakout-risk-check`.

## What it does
TradingView alert -> Cloudflare Worker `POST /hook` -> separate alert records in Workers KV -> private dashboard shows the last five received alerts. It selects the newest alert by default. Selecting another alert clears the entry price and loads its market data. The page shows ticker, FX reference, previous completed week's low, proposed 1% buffered stop, 2R reference, EUR risk and whole-share position size.

The 1% stop buffer is a **research hypothesis**, NOT a validated trading rule. Previous-week low is NOT necessarily the bottom of a weekly base. No order is placed. No ticker entry on the page; source is the alert.

## Deployment (Cloudflare Worker)
1. Create a Cloudflare Worker; copy `worker.js`.
2. Create Workers KV namespace and bind it as `ALERTS`.
3. Add Worker environment secrets `HOOK_TOKEN`, `READ_TOKEN`, `TWELVE_DATA_KEY` (independent random secrets and a Twelve Data API key). Add non-secret variable `ALLOCATION_CAP_EUR` as your per-trade maximum, e.g. `1000`, AFTER explicitly choosing it.
4. Deploy and open `https://YOUR-WORKER.workers.dev/?token=YOUR_READ_TOKEN` from a bookmarked page on phone.
5. Create a TradingView alert. Set its **Webhook URL** to `https://YOUR-WORKER.workers.dev/hook?token=YOUR_HOOK_TOKEN`; include the following valid JSON as **message**:

```json
{"ticker":"{{ticker}}","exchange":"{{exchange}}","close":"{{close}}","time":"{{time}}"}
```

6. Fire a **test** alert and refresh the bookmarked dashboard. Check timestamp and ticker. The dropdown shows the last five received alerts. KV retains separate records so simultaneous writes cannot overwrite alert history. KV propagation can delay history updates across locations; refresh again if needed.
7. Review prices vs your broker before any trade. Validate all market-data entitlements/limits and production readiness.

## Constraints
- TradingView webhook is **server-to-server**, it does not automatically open a website on the phone. You must open the bookmarked dashboard. TradingView app push notification does not become a native deep link to this Worker.
- Both webhook and dashboard endpoints rely on secret tokens (the read token in the bookmark URL can appear in browser history; keep the page private).
- Weekly low is based on daily market bars from a Twelve Data account. Missing data or source errors block calculations. The prototype does not enforce data age or complete weekly session coverage.
- FX is from Frankfurter, not the broker's executable conversion rate; snapshot updates only on business days and may be stale intraday. The page displays its date.
- Previous week's dates are computed in America/New_York and Monday-to-Friday; exchange-specific holidays and non-US listings need additional work.
- The current version assumes USD-listed equities; do NOT use for non-USD securities.
- No guarantee of slippage, fill price, tick consistency, or market order execution.
- Trade Republic prices can deviate from calculated USD-to-EUR stop levels.
- Account size and per-position allocation are NOT the same. Separate portfolio concentration and sector limits must be checked before execution.
- No OCO or take-profit orders are placed.
- Webhook and read tokens should be rotated after exposure.

## Checks

Run `node breakout-risk-check/worker.test.mjs`. It checks access control, the old latest-alert record, simultaneous writes, the five-alert limit, alert selection, entry reset, and delayed response handling. These checks do not validate a trading rule or market-data accuracy.
