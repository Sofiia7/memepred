# Memory Log for memepred

## FULL AUDIT 2026-07-04 — findings, then FIXED 2026-07-05 (see below)

Original findings (all now fixed — see "Sprint 5.5" section below for what changed):
- **P0 settlement stall**: OrderbookMarket.pendingSettlements is append-only; getReadySettlements(0,25) permanently empties after first 25 settled matches/market → new matches never settle. **FIXED**: head-pointer compaction (pendingSettlementsHead).
- **P1 LP economics**: LP pool had zero taker-fee/edge, 60s stale entry price exploitable. **FIXED**: LP_TAKER_FEE_BPS (1% on LP-match user wins) + MAX_TRADER_LP_EXPOSURE (300e6 per-trader cap per market instance). Entry-price staleness (60s) NOT yet tightened — see Task #12 follow-up below.
- **P1 exit-price design**: flat 5-min TWAP ≈ whole match period for 5-min markets. **FIXED**: TWAP window now scales to duration/5 (capped at 5 min, floored at 30s) via OracleResolver._twapWindowFor.
- **P2 product gaps**: no /refer page, no ShareCard, 6/16 badges TODO. **FIXED**: /refer page added, referral ?ref= capture wired end-to-end (was completely dead before — Composer.tsx never passed referrer!), ShareCard added to OrderStatusCard, all 16 badge conditions implemented.
- **P2 MarketFactory dedup**: no guard against duplicate (feedId,duration) markets. **FIXED**: MIN_CREATE_INTERVAL=60s cooldown per slot.

## Sprint 5.5 — audit fixes session (2026-07-05)

All done via TDD (forge test, red→green), branch `sprint-0-5-hardening`, NOT committed yet (user hasn't asked for a commit). 144 forge tests green (was 130). Frontend/backend typecheck clean.

Contracts changed: OrderbookMarket.sol (pendingSettlementsHead, LP_TAKER_FEE_BPS, MAX_TRADER_LP_EXPOSURE, _tryLpMatch extracted to fix stack-too-deep), OracleResolver.sol (TWAP_WINDOW_CAP/MIN_TWAP_WINDOW/_twapWindowFor), MarketFactory.sol (MIN_CREATE_INTERVAL dedup guard).
Tests added: OrderbookMarketAccounting.t.sol (+1), LiquidityPool.t.sol (+3), MarketFactory.t.sol (+5), OracleResolver.t.sol (+5, closed the resolveOrderbookMatch/Batch coverage gap — those are the ACTUAL functions resolveKeeper.ts calls and had near-zero coverage before).
Coverage: OracleResolver.sol 73.56%→97.70% line. Repo total 77.14%→79.45% line. NOT at 95% target yet (GenesisNFT edge cases, LiquidityPool/MarketFactory branch coverage still gaps) — flagged as follow-up before external audit submission, not silently claimed done.

Frontend changed: lib/referral.ts (new — ?ref= capture + localStorage persistence), App.tsx (wired capture + /refer route), usePlaceBet.ts (referrer defaults to captured referral now, was always zero-address), ShareCard.tsx (new), OrderStatusCard.tsx (+ShareCard on won/claimed), pages/Refer.tsx (new), Portfolio.tsx (link to /refer), index.css (+.osc-* and .share-* — OrderStatusCard was COMPLETELY unstyled since Sprint 4.3, never had CSS at all until now).
Backend changed: badgeService.ts — implemented all 6 remaining badge conditions (Sniper=streak>=10, Speed=played a 5-min market, To The Moon=won on a >=10% price move, Champion=#1 weekly leaderboard right now, Connector/Network=5/20 active referrals).
Verified in browser via Preview tool (dev server, VITE_DISABLE_GEOBLOCK=1 added to frontend/.env.local for local-no-backend dev — gitignored, not committed): /refer renders correctly, ?ref= capture fires the resolve call correctly, .osc-* styling applies.

**BLOCKED — needs user action:**
- Sepolia redeploy (Task #5): deployer/keeper/resolver wallets have ~0.003/0.003/0.0014 ETH — NOT enough for a full 6-contract redeploy + role wiring (same failure mode as the documented prior deploy that ran out of gas mid-script). Needs testnet ETH top-up before redeploy can proceed.
- Ops/public backend URL (Task #6): needs a real hosting decision (VPS/cloud), not something to pick autonomously.
- 48h bot-harness soak (Task #7): blocked on #5.
- External audit + bug bounty + mainnet deploy (Task #11): real money / external party, explicitly waiting for user go-ahead per the audit's own recommendation (don't pay for an audit before fixing known issues — which is now done).

## Sprint 5.5 continued (same day, 2026-07-05) — while user tops up Sepolia wallets

Kept going per user's "work all sprints while I fund wallets" instruction. All contract-side, no funded wallet needed.

**Entry-price staleness (was deferred, now done):** ENTRY_MAX_PRICE_AGE 60s→45s (named constant, was inline `60` in OrderbookMarket._getCurrentPrice). Chose 45s not 20s: tightening further would need the keeper's onchainPriceRecorder push cadence (30s in keeper/index.ts) shortened too, which triples the chronically-underfunded keeper wallet's gas spend — not worth it since placeBetWithPyth (frontend's preferred path when Hermes is reachable) already isn't staleness-bound at all. MockPyth.getPriceNoOlderThan now actually reverts on stale price (was ignoring the `age` param entirely — a real, separate testing gap, since it means this protection had NEVER been exercised anywhere). Fixed the resulting 15 test failures across OrderbookMarketAccounting.t.sol/Integration.t.sol/CriticalFixes.t.sol/OracleResolver.t.sol by refreshing pyth.setPrice at the right points (mostly: real feeds keep publishing continuously, so refreshing per-tick in loops is the *correct* simulation, not a workaround). Root cause of the Integration.t.sol block of 5 was interesting: setUp() itself does a 48h warp to test the fee-timelock, staling the price for every single test in the file — fixed by refreshing price at the end of setUp. New tests proving the protection actually works now: OrderbookMarket.t.sol test_PlaceBet_Reverts_StalePrice / test_PlaceBet_Succeeds_AfterRefreshingStalePrice.

**Coverage push (continued from 79.45%):** added GenesisNFT.t.sol (didn't exist at all — 11 tests, one Solidity gotcha found: try/catch does NOT catch "call to address with no code", only real reverts from callee code — had to use a real mock contract as liquidityPool in test setup, not a plain address, matching how production always has a real contract there anyway), sweepDust tests in FeeDistributor.t.sol, pauseMarketsForFeed/setEmergencyPauser tests in MarketFactory.t.sol, mint()/withdraw()/maxRedeem()/isFullyBacked()/availableForMatching() tests in LiquidityPool.t.sol (these ERC4626 entrypoints were never touched — only deposit()/redeem() were tested before).

**Coverage result: 5 of 8 core contracts now 100% line coverage** (BadgeNFT, FeeDistributor, LiquidityPool, MarketFactory, ReferralRegistry). Remaining: GenesisNFT 90.91%, OracleResolver 97.70%, OrderbookMarket 95.48%. Repo total line coverage 77.14%→84.22% this session (branch 70.19%→75.37%). 172 forge tests green (was 130 at session start).

MarketChart.tsx "volume mode stub" noted in the original audit is STALE — the component has since been rewritten with only price/prob modes, no volume stub exists anymore. Not a real gap; don't chase it.

Still blocked, unchanged: Sepolia redeploy (Task #5, wallets being topped up now), public backend URL (Task #6, needs a hosting decision), 48h soak (Task #7, blocked on #5), external audit/bug bounty/mainnet (Task #11, needs explicit go-ahead + real money).

## Sprint progress

- [x] Sprint 0 — Toolchain & CI hotfix (migration 001 fixed, .nvmrc/.foundry-version/.tool-versions, root package.json + pnpm-workspace.yaml, .github/workflows/ci.yml + scripts/ci-db-smoke.mjs, .env.example refresh, .gitignore negation rules)
- [x] Sprint 1 — Contract accounting (OrderbookMarket multi-fill SPLIT, LP.tryMatch returns uint256 matchedAmount, totalAssets() underflow clamp, OracleResolver.t.sol restored, OrderbookMarketAccounting.t.sol invariants, emergencyRefundMatch hardened)
- [x] Sprint 2 — Settlement pipeline + Roles handoff (resolveOrderbookMarketBatch, Deploy.s.sol transferOwnership chain, VerifyRoles.s.sol, oracleWatchdog ETH-fund + stale-auto-pause via MarketFactory.emergencyPauser, /api/keeper/health via Redis)
- [x] Sprint 3 — Backend & DB to orderbook (migration 002 orders/matches/order_matches/_ingested_logs, indexer rewrite with idempotency, profile/leaderboard/markets/referral rewrites, badgeService/streakService, config.ts ABIs, subgraph manifest+mapping ZERO_BI fix, marketCreator keeper)
- [x] Sprint 4 — Frontend UX (orderId-from-receipt redirect, per-market pythFeedId, OrderStatusCard + /order page, runtime env validation, geo-block fail-CLOSED, Genesis NFT label fix, BLOCKED_COUNTRIES single source via /api/geo/config; ABI getOrder updated to 11-field struct)
- [~] Sprint 5 — Testnet soak + CEF apply (in progress; CONTRACTS DEPLOYED to Base Sepolia, VerifyRoles ALL GREEN)
- [ ] Sprint 6 — Audit & Legal

## Base Sepolia deployment (chainId 84532) — CURRENT (2nd deploy, with marketCreator role)

EOAs (same across deploys; keys in .testwallets/):
- Deployer / testnet admin: 0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2  (owns all contracts — see handoff note)
- Multisig stand-in (TESTNET, unused for now): 0xAA1a14ad2f57fc79Ac14b2Cf5e2968Fdaeb9047F  (.testwallets/multisig-standin.json)
- Keeper hot wallet: 0xbFa008e5A8d46d2014b83551ce6209108416eea4  (.testwallets/keeper.json) — has marketCreator + emergencyPauser + KEEPER_ROLE
- Badge minter: 0xb183b09f0D41314EA597598B741b41bcddd875e6  (.testwallets/badge-minter.json)

CURRENT contracts (2nd deploy — .env points here):
- FEE_DISTRIBUTOR   = 0x4680E3A5A27b29dC8fb413DD64614214162cd969
- REFERRAL_REGISTRY = 0x22e34950099f23B04972F62e91975252Ceddf0f5
- ORACLE_RESOLVER   = 0x697BDC64fC8B51189540cFA4110f72060f386020
- GENESIS_NFT       = 0x690a62ebFcd2Fe340369c4693D3bE8F7BA34272D
- LIQUIDITY_POOL    = 0x12bCb6D28aA94BacE1c01e5c49d92c56Df813b59
- MARKET_FACTORY    = 0xFA747ac474eF282B6BEFAb787cF949454b826e51  (marketCreator=keeper SET)
- BADGE_NFT         = 0x25d87695F96ad617511Fd89d5fd0165752c692B7
- First keeper-spawned market (PEPE 5min): 0xa432aC0fddcc843c9B2aa824Fd990268a8Bac776

CONTRACT CHANGE THIS SESSION: added `marketCreator` low-trust role to MarketFactory
(setMarketCreator onlyOwner; createMarket allows resolver||owner||marketCreator).
Deploy.s.sol calls factory.setMarketCreator(keeper). 130 forge tests green (+3).

HANDOFF NOTE: 2nd deploy ran OUT OF GAS mid-script (--slow, ~19 txs, deployer had only
0.0007 ETH) — stopped after setEmergencyPauser, before setMarketCreator + the 5
transferOwnership + 2 access-control renounce calls. So owner = DEPLOYER, not multisig.
On TESTNET this is fine (multisig is just an EOA stand-in, zero security benefit).
marketCreator was set manually afterward. FULL multisig handoff + VerifyRoles deferred to
MAINNET (Sprint 7) with adequate gas. 1st deploy (stale addrs 0xa9DD.../0x2D0a... etc) is
DEAD — old resolver 0x2D0a8a10 has ~0.0006 ETH stuck.

PROVEN on-chain: deploy ✓, marketCreator role (keeper spawns markets w/o owner) ✓,
market auto-authorizes on LP pool ✓.

CONFIG RECONCILIATION (2026-07-02): found deploy/.env + frontend/.env.local (and the
deployed Vercel frontend) were still pointed at an OLD, undocumented deploy
(factory 0x59385ca6…, resolver 0xbbd2dab7…, badge 0x90d22B3e…) that LACKS the marketCreator
role model — verified on-chain: 0x59385ca6.marketCreator() REVERTS, keeper 0xbFa0 has no
roles there. Repointed deploy/.env + frontend/.env.local to the CURRENT 0xFA747 set (above)
and switched deploy KEEPER_PRIVATE_KEY off the reused deployer key to the real keeper key
(keeper.json 0xbFa0 — verified marketCreator on factory + KEEPER_ROLE on resolver 0x697BDC64).
Old 0x59385ca6 set now DEAD (its markets 0x79f25…/0xF617… abandoned).
DONE 2026-07-02: (a) BADGE_NFT 0x25d87695 addMinter(0xb183…) — MINTER_ROLE granted, verified
(tx 0xe45c67b96282921b91d39bfe7971dd7b579eb09b8a186427fd0d41560b433d67); 0xb183 STILL needs
ETH gas (0 now). (b) Vercel project (memepred-frontend) had ZERO env vars → deployed prod site
was non-functional (env.ts assertEnv throws on missing). Added 13 VITE_* vars (canonical
0xFA747 set + rpc/network/pyth/graph) to PRODUCTION via CLI.
STILL TODO (ops): VITE_API_URL not set — needs a REAL public backend URL (only local docker
exists). Vite bakes env at BUILD → prod redeploy required after VITE_API_URL is decided,
else site still shows fatal env screen. Old 0x59385ca6 set DEAD.
FIXED 2026-07-02 (5H.3 done for real): migration 004_invariant_lp_fix.sql redefines the
invariant per-market as A+B+C = unmatched-refundable-remainder + 2×(unsettled-match amount)
+ unclaimed-payout. LP-agnostic (LP-injected funds are the counterparty side of B and cancel
on LP win as the match flips settled). invariantMonitor.ts logic unchanged — reads the
corrected protocol_usdc_summary.expected_onchain_balance vs Σ on-chain balanceOf(market).
Verified via seeded rollback test: expected=31 on A7/B16/C8, CLAIMED/REFUNDED excluded.
004 uses DROP+CREATE (003's view columns differ) and is idempotent. Migration 002 duplicate
(002_add_order_id + 002_orderbook_schema) is COSMETIC only — files independent, no ordering bug.
Secrets rotated same day — see docs/SECRET-ROTATION.md. Diagnostic: scripts/check-testnet.sh.
Local docker stack (postgres/redis/backend) verified up on rotated secrets; keeper svc left OFF.

FUNDING (low!): deployer ~0.0002, keeper ~0.0003, new resolver ~0.0004 ETH.
For a real 48h / 50-bot soak the user MUST top up: deployer+keeper ~0.05 ETH each,
resolver ~0.02 ETH, plus testnet USDC faucet for bot funding wallet. .env deduped (.env.before-dedup backup).
- [ ] Sprint 7 — Mainnet launch

## ⚠ Sprint 5 — Clanker Ecosystem Fund (CEF) plan — DO NOT FORGET

Reference: gmfarcaster CEF grants announcement (Builder $5-8K + Activation, Sustainability $2K, Fresh Clank $1-2K + Activation, Activation $0.5-2K).

When we hit Sprint 5 testnet soak, weave this CEF track in:

1. **Launch a Farcaster mini-app with the prelaunch demo.** Farcaster connector + miniapp.ts already exist in `frontend/src/lib/`. Need a public mini-app URL and frame metadata.
2. **Whitelist Clanker-token Pyth feeds in OracleResolver** via `MarketFactory.addFeed(feedId)`. If a Clanker token has no Pyth feed, decide on alt-oracle bridge before applying.
3. **Cast prediction-markets content** tied to Clanker memes — visibility for @gmfarcaster, @rish, @dish.
4. **Apply for Fresh Clank Grant + Activation Grant** ($1-2K + $1-2K) with the pitch: "prediction markets auto-spawned for every Clanker listing on day-of-launch". Builder Grant only realistic AFTER 2-3 months of mainnet metrics.

Apply order: Fresh Clank first (lower bar, momentum-based), Builder later after mainnet volume.

## Toolchain notes

- Foundry installed at `~/.foundry/bin/` (not in PATH by default) — version 1.7.1
- Node 24.11.1 at `/c/Program Files/nodejs/`
- pnpm not installed locally; npm works. GitHub Actions CI uses pnpm via corepack.
- `forge test` runs from `contracts/` — 127 tests, all green as of end-of-Sprint-3.
