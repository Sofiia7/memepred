# CEF Application Packet — MemePred

For submission to **Clanker Ecosystem Fund** (Fresh Clank + Activation tracks).
Reference cast: gmfarcaster announcing CEF rounds.

---

## TL;DR for the steward

> MemePred is a **non-custodial PvP prediction market for memecoins**, built on
> Base. Users bet USDC on UP/DOWN of a token over a 5-min to 24-hour window;
> Pyth settles, winners split the loser pot. **Targeted Clanker fit:** we
> auto-spawn prediction markets the moment a Clanker token gets a Pyth feed —
> every launch becomes a tradable event, drawing attention back to the token.

---

## Asks

| Track | Amount | What for |
|---|---|---|
| Fresh Clank Grant | $1,500 | Sepolia → mainnet deploy gas + audit prep (Cantina/Sherlock listing fee) |
| Activation Grant | $1,500 | "Top 20 Clanker tokens × auto-spawn markets" — keeper config, monitoring, KOL cast budget |

---

## Why we fit

1. **Clanker-aligned product**: We don't compete with Clanker, we *consume* its
   token list. Every Clanker token with a price feed becomes a market on day one.
2. **Already shipped**: Smart contracts audited internally (127 tests, USDC
   conservation invariant proven). Sepolia soak passing 48h on submission day.
3. **Farcaster-native**: Mini App via @farcaster/miniapp-sdk; users bet without
   leaving Warpcast. Frame-first design.
4. **Public goods angle**: Open-source subgraph + indexer for orderbook-style
   markets — anyone else building rolling prediction markets on Base benefits.

---

## Technical posture

- **Stack**: Solidity 0.8.24 (Foundry), Fastify + Postgres (TimescaleDB) + Redis,
  React + Vite + wagmi v2, The Graph subgraph, Cloudflare Worker geo-block.
- **Oracle**: Pyth on Base. TWAP over 5-min window. 2% spread guard → auto-refund.
- **Matching**: Three layers — PvP orderbook → LP vault (ERC4626, soulbound shares,
  Genesis NFT 1.5× boost) → 5-min queue → refund. Multi-fill correct (Sprint 1.1).
- **Operational safety**: Multisig 3/5 owns every contract (Sprint 2.3); keeper has
  low-trust emergencyPauser role (can pause, can't unpause). 48h timelock on fee
  changes, max 1% fee.
- **Monitoring**: Tenderly alerts on refund, pause, fee change, LP large withdraw,
  resolver ETH low. USDC conservation invariant checked every 60s.

---

## Concrete CEF-aligned actions in next 30 days

| Week | Deliverable |
|---|---|
| 1 | Whitelist top-10 Clanker tokens that have Pyth feeds. For the rest, ship a Chainlink-style alt-oracle bridge or skip with a note. |
| 1 | Cast series: "Predicting <token>: open till close" — 1 cast per Clanker market, tagging the token's caster and @gmfarcaster. |
| 2 | "Auto-spawn on listing" worker — listen to Clanker's launch contract on Base, call `MarketFactory.createMarket(feedId, dur)` within 1 min of launch. |
| 3 | Public Grafana dashboard: live USDC volume on Clanker token markets vs total volume — proves the activation actually drove activity. |
| 4 | Builder retrospective cast with metrics: # markets, total volume, unique traders, % from Clanker tokens. |

---

## Track record

- **Sprint 0-5 completion** (this submission): every sprint shipped end-to-end
  with green CI, dev local verification (127 forge tests, backend tsc, subgraph
  build, frontend tsc).
- **Sepolia deploy**: `0x...` (filled in at submit time)
- **Subgraph**: `https://api.studio.thegraph.com/query/.../memepred-sepolia/...`
- **Mini App**: `https://memepred.xyz` — open in Warpcast → "Predict" button
- **Repo**: github.com/... (link at submit time)

---

## Cast drafts

**Day-0 prelaunch announcement:**
> 🧪 prelaunch on base sepolia
>
> memepred — PvP prediction markets on memecoins.
> bet UP or DOWN on $PEPE / $DOGE in 5min, 15min, 1h, 4h, 24h windows.
> usdc settled, non-custodial, pyth-oracled.
>
> first 20 LP get a Genesis NFT + 1.5× fee share — forever.
>
> miniapp: memepred.xyz
> /clanker tokens going live as feeds come online.
>
> cc @rish @dish @gmfarcaster — would love feedback

**Day-of activation (when first Clanker market spawns):**
> first /clanker market on memepred is live:
> $CHRTM ▲ vs ▼ — 1h window
>
> reply with your call, screenshot the receipt, get a sat-back from the protocol
> if you call correctly (capped at $5 per cast for the launch week).

**Builder grant report cast (week 4):**
> 4 weeks since /cef activation grant — recap:
>
> · X markets spawned across Y Clanker tokens
> · $Z volume traded
> · N unique wallets
> · USDC conservation invariant: never breached (proof: dashboard link)
>
> next: builder grant target — mainnet, oracle redundancy, social settlement for tokens without Pyth feeds.
