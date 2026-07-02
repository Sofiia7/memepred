# Memory Log for memepred

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
STILL TODO (ops, off-machine): (a) update VERCEL project env to the 0xFA747 set — the
deployed site still serves the dead 0x59385ca6 set until then; (b) BADGE_NFT 0x25d87695 has
MINTER_ROLE granted to NOBODY → owner must addMinter(0xb183…) AND fund 0xb183 (0 ETH now).
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
