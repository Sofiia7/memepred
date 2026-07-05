# CEF Outreach Draft — MemePred

**⚠️ Updated [session: 2026-07-05]. Corrections from the previous version of
this file, verified live against gmfarcaster.com/cef via web search/fetch —
do not resubmit the old numbers/process below, they were wrong:**

1. **There is no formal application form/packet.** CEF has no submission
   portal. The actual mechanism is: (a) a "Name / Email / Message" contact
   form on gmfarcaster.com/cef, or (b) posting in the `/CEF` channel on
   Farcaster. This file's job is to produce the actual **note text** to
   send via one of those — not a packet to upload anywhere. Keep the fuller
   background material below for when a steward asks follow-up questions,
   but lead with the short note in §"Ready-to-send note", not this whole file.
2. **Grant tiers/amounts corrected** (per gmfarcaster.com/cef, most recent
   round observed): Builder $26,000/4 grants (~$6.5K avg), Sustainability
   $43,000/30 grants (~$1.4K avg), **Fresh Clanks $6,500/4 grants (~$1.6K
   avg)**, **Activations $14,500/17 grants (~$850 avg)**. The old $1,500 +
   $1,500 ask below was a guess from memory, not verified — adjusted the ask
   to match observed averages so it doesn't read as out of touch with actual
   round sizes. Round cadence/exact eligibility criteria are not fully
   public — mention you're flexible on amount rather than anchoring hard.
3. **Two blockers found this session — fix before reaching out, not after:**
   - `frontend/public/.well-known/farcaster.json` still has a placeholder
     `accountAssociation`. Until [YOU] sign it in Warpcast Dev Tools (see
     `docs/sprint5/operator-guides.md` §1), the "Mini App" link in this
     pitch renders as a plain webpage in Warpcast, not a mini-app — a
     steward who taps it will see that immediately. This needs your own
     Farcaster account's signature; it cannot be done on your behalf.
   - The public backend URL still isn't set (`VITE_API_URL` unset in prod
     Vercel — see project memory) — the live site currently shows a fatal
     env-config screen instead of the app. Fix this before sending any link
     to a steward.

---

## Ready-to-send note (paste into the CEF contact form or /CEF cast)

> Hey — building MemePred, a non-custodial PvP prediction market for
> memecoins on Base (bet USDC on UP/DOWN over 5min–24h windows, Pyth-settled,
> winners split the losing side's pool). Looking at it through a Clanker
> lens: every Clanker token that earns a Pyth feed becomes an instantly
> tradable prediction market — no manual listing step, the keeper picks it
> up automatically.
>
> Where we are: contracts are through internal hardening (172 Foundry tests,
> LP-vault economics + oracle-freshness fixes just closed), Sepolia
> soak in progress, Farcaster mini-app wired via @farcaster/miniapp-sdk.
> Not live on mainnet yet — this is a Fresh Clank-stage ask, not a Builder
> retroactive one.
>
> Would love a Fresh Clank / Activation grant to help fund the mainnet
> deploy + a short activation window casting live Clanker-token markets as
> they spawn. Happy to share the repo/demo and adjust scope to whatever size
> makes sense on your end — open to feedback before finalizing.
>
> [YOUR NAME/HANDLE] · [LINK: mini-app once accountAssociation is signed] · [REPO LINK]

---

## TL;DR for the steward

> MemePred is a **non-custodial PvP prediction market for memecoins**, built on
> Base. Users bet USDC on UP/DOWN of a token over a 5-min to 24-hour window;
> Pyth settles, winners split the loser pot. **Targeted Clanker fit:** we
> auto-spawn prediction markets the moment a Clanker token gets a Pyth feed —
> every launch becomes a tradable event, drawing attention back to the token.

---

## Ask (adjusted to observed round averages — see correction #2 above)

| Track | Amount | What for |
|---|---|---|
| Fresh Clank | ~$1,500–1,600 | Mainnet deploy gas + audit-prep (Sherlock/Cantina listing) |
| Activation | ~$800–1,000 | Keeper config for auto-spawn on Clanker launches + a short cast/KOL push during the activation window |

---

## Why we fit

1. **Clanker-aligned product**: We don't compete with Clanker, we *consume* its
   token list. Every Clanker token with a price feed becomes a market on day one.
2. **Already shipped**: 172 Foundry tests passing (contracts + LP-vault
   economics + oracle-freshness hardening closed this cycle), USDC
   conservation invariant checked every 60s by an off-chain monitor.
   Sepolia redeploy + 48h soak in progress — do NOT claim "soak passed" to a
   steward until the actual 48h run in Task #7 has completed and been
   checked; update this line with the real result before sending.
3. **Farcaster-native (pending your signature)**: Mini App wired via
   @farcaster/miniapp-sdk, but `accountAssociation` in
   `frontend/public/.well-known/farcaster.json` is still a placeholder — it
   will show as a plain webpage in Warpcast until you sign it (see blocker
   #3 at the top of this file). Don't claim "Farcaster-native" in the note
   until this is actually signed and verified.
4. **Public goods angle**: Open-source subgraph + indexer for orderbook-style
   markets — anyone else building rolling prediction markets on Base benefits.

---

## Technical posture

- **Stack**: Solidity 0.8.24 (Foundry), Fastify + Postgres (TimescaleDB) + Redis,
  React + Vite + wagmi v2, The Graph subgraph, Cloudflare Worker geo-block.
- **Oracle**: Pyth on Base. Exit price uses a duration-scaled TWAP window
  (was a flat 5-min window that over-smoothed short-duration markets — fixed
  this cycle) with a 2% spread guard → auto-refund on anomaly.
- **Matching**: Three layers — PvP orderbook → LP vault (ERC4626, soulbound
  shares, Genesis NFT 1.5x boost) → 5-min queue → refund. Multi-fill correct.
  LP-match wins now carry a 1% taker fee funding the vault (closed a
  zero-edge LP economics gap this cycle) and a per-trader LP-exposure cap
  bounds single-address sniping.
- **Operational safety**: Deploy script performs a full ownership handoff to
  a multisig at the end of deployment (see `contracts/script/Deploy.s.sol` +
  `VerifyRoles.s.sol`) — **verify this has actually completed on whichever
  deployment you link a steward to before claiming "multisig-owned"; the
  prior testnet deploy ran out of gas mid-handoff and left the deployer EOA
  in control — check current owner() on-chain, don't assume the script's
  intent already happened.** Keeper holds a low-trust emergencyPauser role
  (can pause, cannot unpause). 48h timelock on fee changes, max 1% fee.
- **Monitoring**: USDC conservation invariant checked every 60s
  (`keeper/invariantMonitor.ts`). Oracle watchdog auto-pauses markets on a
  stale feed. Tenderly alerting is scoped in `deploy/tenderly-alerts.yaml`
  — confirm it's actually wired to a live Tenderly project before claiming
  it as a shipped feature.

---

## Concrete CEF-aligned actions in next 30 days

| Week | Deliverable |
|---|---|
| 1 | ~~Whitelist top-10 Clanker tokens that have Pyth feeds.~~ **Done this cycle** — 11 Tier A Base-native feeds (BRETT, TOSHI, DEGEN, AERO, MORPHO, WELL, BAN, B3, MOBY, AVNT, AIXBT) added to `Deploy.s.sol`, will go live on the next redeploy. See `docs/sprint5/pyth-feeds-base-memes.md` for the researched Tier B list and the alt-oracle plan for Clanker tokens without a Pyth feed (still not built — real remaining work, not done). |
| 1 | Cast series: "Predicting <token>: open till close" — 1 cast per Clanker market, tagging the token's caster and @gmfarcaster. |
| 2 | "Auto-spawn on listing" worker — listen to Clanker's launch contract on Base, call `MarketFactory.createMarket(feedId, dur)` within 1 min of launch. |
| 3 | Public Grafana dashboard: live USDC volume on Clanker token markets vs total volume — proves the activation actually drove activity. |
| 4 | Builder retrospective cast with metrics: # markets, total volume, unique traders, % from Clanker tokens. |

---

## Track record

- **Engineering state at last check**: 172 Foundry tests green, backend/frontend
  typecheck clean, subgraph builds. Core-contract line coverage 84% overall,
  5 of 8 contracts at 100% line coverage. Update these numbers from the
  latest CI run before sending — don't paste stale figures into a pitch.
- **Sepolia deploy**: `0x...` — fill in the redeployed address once Task #5
  (redeploy with all fixes) completes; the old deploy predates this cycle's
  fixes, don't link it.
- **Subgraph**: `https://api.studio.thegraph.com/query/1753939/memepred-sepolia/v0.0.1`
  — confirm it's re-pointed at the new deploy's contract addresses before linking it.
- **Mini App**: `https://memepred.xyz` — will open in Warpcast as a real mini-app
  only after the `accountAssociation` signature (blocker #3, top of file) is done.
  Until then this link opens as a plain webpage, and the public backend URL
  blocker means it may show a fatal env-config screen — check it loads before sending.
- **Repo**: [add link if you're comfortable making it public / sharing with stewards]

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
