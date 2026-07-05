# Pyth Ecosystem Grants — Developer Grant draft — MemePred

**Status: draft, not sent.** Written 2026-07-05 alongside the CEF note
(`docs/sprint5/cef-application.md`) — reuses the same verified facts, same
honesty rules: don't claim the 48h soak has run (it hasn't), don't claim
mainnet (not deployed there), don't claim more test/coverage than the
latest `forge test` / `forge coverage` run actually shows.

Program: Pyth Data Association Ecosystem Grants, **Developer Grants**
category (new tools/integrations built on Pyth products — SDKs, APIs,
integration patterns — as opposed to Community or Research grants). Paid in
PYTH tokens (locked or unlocked), not USD — factor that into any budget
planning. No confirmed public application portal found this session; likely
routed through the same kind of contact form / community channel pattern as
CEF. **[Sofia: verify current submission mechanism at pyth.network before
sending — grant program mechanics change; don't assume this draft's
assumptions about "how to submit" are still accurate by the time you send.]**

---

## Ready-to-send note (adapt to whatever the actual submission channel turns out to be)

> Hey — building MemePred, a non-custodial PvP prediction market for
> memecoins on Base. Users bet USDC on UP/DOWN of a token over 5min–24h
> windows; Pyth price feeds settle every market via a TWAP-based exit
> price, non-custodial, no manual oracle intervention.
>
> The part I think is relevant to a Developer Grant: ultra-short-duration
> markets (5–15 min) expose a real gap in naive TWAP usage — a flat TWAP
> window that's the same length as the market duration ends up averaging
> over the ENTIRE match, which dilutes the actual "closing price" signal
> with stale early-period ticks. We built a duration-scaled TWAP window
> (window = duration/5, floored at 30s, capped at 5 min) plus a spread-vs-spot
> anomaly guard that auto-cancels settlement (routes to refund) instead of
> locking in a bad exit price when TWAP and current spot diverge >2%. Both
> are open-source (`contracts/src/OracleResolver.sol`) and reusable by
> anyone building short-duration/high-frequency markets on Pyth — this
> isn't a one-off hack specific to our contract, it's a general pattern for
> "how do you get a fair closing price out of a push/pull oracle when your
> settlement window is minutes, not hours."
>
> Where we are: 176 Foundry tests passing, deployed and role-wired on Base
> Sepolia, soak testing not yet run (funding a keeper wallet currently).
> Not live on mainnet. This is a pre-launch ask, not a retroactive one.
>
> Happy to walk through the contract or adjust scope — open to feedback on
> whether this fits Developer Grants vs another category.
>
> [YOUR NAME/HANDLE] · [REPO LINK] · [CONTACT]

---

## Why this fits Developer Grants specifically

Pyth's Developer Grants are for "new tools to support protocol operations
and innovative integrations with Pyth products" — SDKs, APIs, integration
patterns, not just "an app that uses Pyth." The pitch here is the **pattern**,
not the app: two small, extractable, tested pieces of logic that anyone
building short-duration on-chain settlement against Pyth would hit the same
problem and could reuse the same fix.

1. **Duration-scaled TWAP window** (`OracleResolver._twapWindowFor`,
   `contracts/src/OracleResolver.sol:169`): `window = clamp(duration/5, 30s,
   5min)`. A 5-minute market gets a ~60s exit window instead of averaging
   over its entire 5-minute life; a 24h market caps at a 5-minute window
   instead of ballooning. Proven with a dedicated test
   (`test_TWAP_WindowScalesDownForShortDurationMarket` in
   `contracts/test/OracleResolver.t.sol`) showing an 8-tick stale-price
   sequence followed by a genuine 2x price move: the flat-window approach
   would land on a blended ~$1.33 "exit price" for a market that actually
   closed at $2.00; the duration-scaled window correctly resolves to $2.00.
2. **Spread-vs-spot anomaly guard** (`OracleResolver._spread` +
   `MAX_SPREAD_BPS`, same file): before settling, compare the computed exit
   TWAP against Pyth's current spot price. If they diverge more than 2%,
   don't settle — emit `MarketRefunded` and let the match refund instead of
   locking in a price that likely reflects a feed glitch or a genuine
   extreme-volatility event the TWAP hasn't caught up to yet.
3. **Amortized O(1) price-history cleanup** (`historyHead` pointer pattern,
   same file): a naive "delete old price points" implementation re-shifts a
   storage array every cleanup call, which gets expensive as the array
   grows; this instead just advances a head pointer, same idea as the
   `pendingSettlementsHead` fix already shipped in `OrderbookMarket.sol` for
   an unrelated append-only-array growth problem found in the same audit
   pass. Small pattern, real gas savings for anyone polling Pyth on a timer.
4. **Dual price-freshness path**: the keeper pushes Pyth updates on-chain
   every 30s (`backend/src/keeper/onchainPriceRecorder.ts`) for markets that
   rely on `placeBet()`, while `placeBetWithPyth()` lets a bettor pay for and
   push a fresh Hermes update inline in the same transaction for
   staleness-critical entries — `ENTRY_MAX_PRICE_AGE` (45s,
   `contracts/src/OrderbookMarket.sol:101`) bounds the first path; the second
   path isn't staleness-bound at all since it always pushes fresh data.
   Both paths are tested (`test_PlaceBet_Reverts_StalePrice`,
   `test_C3_PlaceBetWithPyth_RefundsExcessEth`).

---

## Technical posture (facts, verified 2026-07-05 — same session as the CEF note)

- **176 Foundry tests green**, 83.4% line / 75.8% branch coverage across
  8 core contracts (5 of 8 at 100% line). `forge coverage --report summary`
  is the source of truth — re-run before quoting these numbers in whatever
  you actually send.
- **Pyth integration points**: `OracleResolver.sol` (TWAP + anomaly guard,
  described above), `OrderbookMarket._getCurrentPrice` (entry price with
  staleness bound), `MockPyth.sol` test double (this session's audit found
  and fixed a real gap here too: `getPriceNoOlderThan` was silently ignoring
  its own staleness parameter, so the staleness protection above had never
  actually been exercised by any test until it was fixed).
- **Deployed**: Base Sepolia, MarketFactory
  `0x77cb2EE5695CfFD3bD2043afe7eb910Ec0fe71b0`, verified on-chain as fully
  role-wired (ownership handed to a multisig, keeper roles set, 13 price
  feeds whitelisted including 11 Base-native memecoins). **Not** yet soak
  tested with real trading activity, **not** on mainnet — say so plainly if
  asked.
- **Open source**: repo link TBD (Sofia to decide whether to make it public
  before sending this).

---

## What NOT to claim (guardrails, since this reuses verified facts from the audit — don't let scope drift as this ages)

- Don't say "battle-tested" or "production" — it's Sepolia-only, zero real
  user orders placed on any deployed market as of 2026-07-05
  (`nextOrderId() == 1` on every spawned market checked).
- Don't say the 48h soak passed — it hasn't run yet (keeper wallet
  underfunded, see project memory).
- Don't overstate novelty — duration-scaled TWAP windows and spread guards
  are known DeFi oracle patterns in general; the pitch is a concrete,
  tested, reusable Solidity implementation of them against Pyth
  specifically, not a claim of inventing the concept.
