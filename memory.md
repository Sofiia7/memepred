# Memory Log for memepred

## Cost teardown + launch posture decision, 2026-07-25

Sofia asked two things honestly: what will running markets on mainnet actually
cost, and how critical is the legal/company work *right now* — explicitly "я
знаю как правильно, но меня интересует как можно", refusing to spend on an
entity and a lawyer before knowing whether anyone wants the product.

**Cost finding.** `MarketFactory.createMarket` was doing `new OrderbookMarket(...)`
— a full 16.8kB contract deployment per market, ~3.85M gas. The keeper rolls a
fresh market per (feed × duration) every `duration/2`, which at 2 feeds × 5
durations is ~988 markets/day, so the burn was set by the market matrix and not
by user activity: **$1,617/mo at zero users**, and 8–80× that if Base gas leaves
its floor (which is exactly when a memecoin market would be busy). The 5m and 15m
slots alone were 87% of it. Full model, measured numbers and methodology live in
the `flipthememe-onchain-cost-model` memory rather than here.

**Fixed this session** (all verified, 194 forge tests green, backend vitest 22
green, frontend tsc + production build clean):
- **Markets are now EIP-1167 clones.** `pythFeedId`/`duration` moved
  immutable→storage; the six globally-identical addresses stay immutable since
  clones execute the implementation's code. New `initialize()` gated on the
  `factory` immutable; `_init()` shared with the constructor so direct
  deployment still works unchanged (all 7 existing `new OrderbookMarket` call
  sites in tests/scripts untouched) and leaves the implementation permanently
  initialized so nobody can claim it. **The trap avoided:** `nextOrderId = 1` /
  `nextMatchId = 1` were inline field initializers, i.e. constructor code — a
  clone would have started both at 0, and 0 is the "no match" sentinel in
  `Order.matchId`, so matched orders would have read as unmatched forever. Every
  existing test deploys directly and would have stayed green. 13 new tests in
  `contracts/test/MarketClone.t.sol` cover exactly this class. Measured:
  **327,562 gas vs 3,592,122**. `MarketFactory` runtime also shrank 21,817→4,120 B.
- **On-chain Pyth pushes are now demand-gated.** Was 5,760 tx/day flat; new
  `backend/src/lib/activity.ts` stamps user presence from the API (excluding
  health/monitoring endpoints, or an uptime checker would keep it hot forever)
  and the recorder backs off to a 5-min heartbeat when idle. Safe because the
  frontend's primary path is `placeBetWithPyth`, which carries its own fresh
  update, and loading the app re-arms the fast cadence within one tick. Fails
  *hot* on any error — overpaying gas beats a stale oracle blocking settlement.
- Net: **$1,617/mo → ~$150/mo** at zero users, 10.8× cheaper.
- Keeper's pinned `gas` for createMarket lowered 5,000,000 → 800,000 as a cap
  that fails loudly if a real deployment is ever reintroduced.

**Launch posture decided** (details in the `flipthememe-launch-posture` memory):
ship unaudited but capped at `MAX_BET` 100 USDC with the risk stated aloud, block
the US, defer incorporation until named triggers. Implemented: `workers/geo-block.ts`
now blocks US + territories, GB/FR/DE/NL/CA/AU/JP/SG and Tor, split in-code into
an OFAC layer and a regulatory-risk layer; Terms §3 rewritten to match, §4 hardened
on the unaudited/cap point, new §12 bug bounty with safe harbour; new
`RiskDisclosure.tsx` gives a blocking first-visit notice plus a permanent
"UNAUDITED · MAX BET 100 USDC" strip. Verified live in the browser.

**Correction worth remembering:** I initially described the ToS as contradicting
the code ("says it blocks the US, doesn't"). That was true of
`docs/legal/tos-privacy-draft.md`, which is explicitly marked DO-NOT-PUBLISH —
the *live* Terms page was consistent with the old narrow block and honest about
having no entity and no audit. Check which artifact is actually shipped before
calling something a live contradiction.

**Left for Sofia:** set `VITE_SECURITY_CONTACT` (bug bounty currently renders a
deliberate visible "NOT YET PUBLISHED" placeholder), and pick the audit route.
Nothing here is deployed — contracts still need a fresh deploy for the clone
change, and the Worker needs `wrangler deploy` for the geo-block to take effect.

## Full ТЗ-vs-code audit + Phase 0 remediation, 2026-07-08

Sofia asked for a full audit (ТЗ vs code, security, completeness, feature-to-UI
mapping) and a mainnet/advertising go/no-go. Delivered as an artifact (4 parallel
review passes: contracts, backend/infra, frontend, legal/marketing). **Verdict:
NO-GO on both mainnet and public advertising** — no external contract audit has
happened, no mainnet deployment exists at all (still Base Sepolia only), and two
new bugs were found live. Full findings/plan are in the delivered artifact, not
duplicated here; this entry covers what got fixed same-day.

Sofia then said to execute all phases in order, deferring anything needing her
own live testing/action to a written list for the next day. Did:

- **Fixed the new live crash**: `frontend/src/pages/Order.tsx` had the same
  Rules-of-Hooks bug already fixed once in MarketCard — an early return before
  `useClaim`/`useWriteContract`/`useEnsureChain`/`useState`. Since React Router
  doesn't remount across param changes on the same route, navigating between
  two `/order/:address/:orderId` URLs (or hitting an invalid one) changed the
  hook count between renders and crashed the page. Moved all hooks above the
  early return, same pattern as the MarketCard fix.
- **Fixed a keeper regression**: `oracleWatchdog.ts`'s `maybePauseFeed` called
  `privateKeyToAccount()` directly instead of the shared `getKeeperWalletClient()`
  — bypassing the nonce-manager `keeperWallet.ts` was built specifically to add
  (2026-07-06, see below), reintroducing the exact "replacement transaction
  underpriced" collision risk across concurrent keeper loops.
- **Hardened the backend container**: `deploy/backend.Dockerfile` had no `USER`
  directive — both `backend` and `keeper` ran as root. Now run as node:20-alpine's
  built-in non-root `node` user.
- **Fixed nav discoverability**: How-it-Works and Terms were only reachable via
  a tiny "?" icon in the header. Added a persistent footer link row in
  `AppShell.tsx` (below page content, above the fixed tab bar) so every screen
  has them.
- **Verified, not a bug**: the earlier audit flagged "does the Genesis 80%/1.5x
  fee boost actually follow the NFT when it's resold?" as worth checking.
  Traced it: `LiquidityPool.isGenesis()` reads `genesisNFT.balanceOf()` live, and
  `GenesisNFT._update()` calls `onGenesisTransfer()` on every transfer (mint
  included) to resync fee weights. Confirmed correct as designed — false alarm.
- **Verified forge tests live** (the prior audit pass couldn't — `forge` wasn't
  on PATH in that session; it's at `~/.foundry/bin/`, just not on PATH by
  default). 176/176 passed, matching the self-reported number exactly. Coverage
  also matched exactly: 83.44% line / 75.81% branch repo-wide.
- **Closed OracleResolver's branch-coverage gap** (was the worst of any
  contract: 57.14% branch despite 97.70% line — the TWAP window CAP/floor
  clamps and the batch-settlement anomaly-cancel path had constants and code
  but had literally never been triggered by a test). Added 5 tests; now 100%
  line / 92.86% branch. Repo-wide: 181 tests, 77.62% branch. Left OrderbookMarket
  (28 uncovered branches), FeeDistributor/LiquidityPool/MarketFactory/
  ReferralRegistry (smaller gaps) as follow-up — didn't try to rush a financial
  contract's test-writing under time pressure just to hit a number.
- **Added CI hardening**: backend + frontend now have vitest wired into CI as a
  required step (first real tests: `backend/src/lib/validate.ts`'s zod schemas,
  `frontend/src/lib/referral.ts`'s `?ref=` capture). Added Slither (contracts)
  and `npm audit` (backend/frontend) as informational-only jobs (not in
  `ci-passed`'s `needs`, so a new transitive-dep advisory can't silently block
  an unrelated hotfix merge). Applied `npm audit fix` (non-breaking only) —
  fixed the backend's ws/viem and esbuild advisories. Deliberately did NOT run
  `--force`: backend's fastify v4->v5 bump and frontend's 35 WalletConnect/
  @reown advisories all need it, and forcing either right after just fixing
  wallet-connect code (a7fa630) would be reckless without dedicated review/testing.
- Committed everything in 6 logical commits (frontend client-journey fixes,
  backend/keeper fixes, deploy/infra, contract test coverage, CI hardening,
  this memory log) rather than one giant commit.

**Deferred to Sofia (needs her live action, not code)**: fund Sepolia wallets,
run/monitor the 48h soak test, engage an external auditor, decide governing
law + set up a public contact channel for Terms, the real mainnet deploy, and
marketing — see the tomorrow-list delivered alongside this.

## Session continued 2026-07-07, part 3 — both fixes DEPLOYED LIVE, Sofia said "давай"

Sofia explicitly authorized both pending deploys ("давай" twice). Executed:

**UNKNOWN-markets fix: deployed + backfilled, verified live.** scp'd fixed
indexer.ts/marketCreator.ts to VPS, `docker compose build backend keeper &&
up -d backend keeper` — built and restarted clean, `/health` 200 after.
Ran one-time backfill SQL (saved at scratchpad/backfill.sql pattern, not
committed to repo — it's a data migration, not code): **335 stale markets
closed** (OPEN→CLOSED, close_time had passed), **288 markets' feed_symbol
corrected** from UNKNOWN to their real symbol, 0 orders needed fixing
(matches the known "zero real orders ever placed" fact). Verified via live
public API: `GET /api/markets?status=OPEN` now returns exactly 13 markets,
one per whitelisted symbol, zero UNKNOWN. Before: 348 markets, 288 of them
UNKNOWN, all-time OPEN accumulation.

**Cloudflare Worker (OFAC geo-block): deployed + live, verified end-to-end.**
Rotated WORKER_SECRET on VPS (`deploy/.env`) to a freshly-generated value,
restarted backend, confirmed healthy. Set the same value via `wrangler
secret put` (this auto-created the Worker — it hadn't existed before despite
the wrangler.toml, confirmed via wrangler's own prompt). `wrangler deploy`
succeeded, route active: `api.flipthememe.com/*`. Verified via curl:
`/health` 200 (pass-through works), `/api/geo` 200 returning a real resolved
country (not the old 401), `/api/geo/config` 200 returning the correct
`["CU","IR","KP","SY"]` OFAC-only list, `/api/markets` CORS headers intact.
Only after all of that verified working did I remove `VITE_DISABLE_GEOBLOCK`
from Vercel prod env and run `vercel deploy --prod` — confirmed live site
(`flipthememe.com`) still serves the real app (200, correct title), not the
old fatal/blocked state. **Geo-blocking is now actually enforced** (OFAC-only
list, per Sofia's decision) — this had been dormant/unenforced since the
Worker was never deployed, despite code existing for it since Sprint 4.

Local scratch files used for this (backfill.sql, the fresh WORKER_SECRET
value) are not committed anywhere in the repo — the secret only exists in
the VPS's `deploy/.env` and the Cloudflare Worker's encrypted secret store,
consistent with how POSTGRES_PASSWORD/REDIS_PASSWORD were handled at
original deploy time.

## Session continued 2026-07-07 — Cloudflare Worker prep, real UNKNOWN-markets root cause, ToS written

**Cloudflare Worker (OFAC geo-block): code ready, NOT deployed.** Sofia flipped
`api.flipthememe.com`'s DNS record to Proxied (orange cloud) herself — confirmed
via curl (`Server: cloudflare` + `CF-RAY` headers now present, site still healthy).
Verified via Cloudflare docs (WebFetch/WebSearch, not memory) that a same-zone
`fetch()` subrequest from within a Worker always goes straight to the configured
origin and can NEVER loop back into the Worker itself — this is Cloudflare's
documented anti-loop behavior, not an assumption. Rewrote `workers/geo-block.ts`
to drop the originally-planned separate `ORIGIN_URL`/`api-origin` hostname
entirely (unnecessary complexity) — it now just re-fetches `request.url`
(same hostname) with the country/secret headers attached, confirmed safe by
the docs above. `workers/wrangler.toml` route fixed to a plain Route (not
`custom_domain`, which would've had Cloudflare try to manage its own DNS
record and conflict with the A record Sofia already has). `wrangler deploy
--dry-run` validates clean. wrangler IS already OAuth-authenticated to her
account (`sofiaseremeteva@gmail.com`, has `workers`/`workers_routes` write
scope) — I could technically deploy, but **the auto-mode classifier correctly
blocked** (a) rotating `WORKER_SECRET` on the VPS and (b) the resulting
Worker deploy, as a live cross-system production change she hadn't explicitly
authorized *for this specific mechanism*. Generated a fresh WORKER_SECRET
value this session (not reusing/reading the old one) but did NOT write it
anywhere yet. **Waiting on Sofia's explicit go-ahead** to: rotate
WORKER_SECRET on VPS (`/home/openclaw/memepred/deploy/.env`) + restart
backend, `wrangler secret put` + `wrangler deploy` the Worker, verify via
curl, THEN (only after verifying) remove `VITE_DISABLE_GEOBLOCK=1` from
Vercel prod + redeploy. Do not skip the verify-before-disabling-kill-switch
step — if the Worker/secret pairing is wrong, removing the kill switch
fail-closed-blocks 100% of traffic.

**UNKNOWN markets — real root cause found, TWO separate bugs, both fixed in
code but NOT deployed to the VPS (same classifier block as above, for the
same reason — direct scp to the live prod backend without an explicit
per-action go-ahead):**
1. `backend/src/keeper/indexer.ts`'s `feedSymbolFromId()` only mapped
   PEPE/DOGE — verified on-chain via `getAllFeedIds()` that the factory has
   13 feeds whitelisted (matches `docs/sprint5/pyth-feeds-base-memes.md`'s
   Tier A list + PEPE/DOGE exactly). The other 11 feeds' markets were
   silently falling through to 'UNKNOWN'. Fixed: full 13-entry map added.
2. **Bigger bug**: nothing in the entire backend ever transitioned a
   `markets` row's `status` away from `'OPEN'` once `close_time` passed —
   `createMissingMarkets()` only ever INSERTs new rows per (feed,duration)
   slot every 5 minutes, it never retires old ones. Confirmed via grep: zero
   other `UPDATE markets ... status` statements exist anywhere. This is why
   dozens of stale "5m ⌁ 00:00" markets pile up forever — pure accumulation,
   independent of the keeper-wallet-gas funding issue (that issue affects
   individual match settlement, not this table's display status at all).
   Fixed: added `closeExpiredMarkets()` (`UPDATE markets SET status='CLOSED'
   WHERE status='OPEN' AND close_time <= NOW()`), called at the top of every
   `createMissingMarkets()` tick (every 5 min).
   Both fixes only affect FUTURE inserts/ticks — existing bad rows in the
   live DB need a one-time backfill (UPDATE feed_symbol from feed_id map +
   the same close_time sweep) once the code is actually deployed.

**ToS + Privacy written and live** at `/terms` (`frontend/src/pages/
Terms.tsx`), linked from `/how-it-works`. Adapted from `docs/legal/
tos-privacy-draft.md` but with the "if no entity exists, do not launch"
gate REMOVED — Sofia explicitly decided to launch without a legal entity
("я не верю что все крипто соло проекты делают какую-то фирму и юристов"),
so the page instead honestly states "operated by an individual developer,
not a registered company" rather than pretending otherwise. Eligibility
section (§3) matches the new OFAC-only enforcement list, not the old
9-country one. Governing-law and contact sections left as honest
placeholders (unknown/not set up yet), everything else is real, filled-in
text, not bracketed TODOs.

**Sofia's mainnet timing decision**: going to mainnet ASAP, explicitly NOT
running paid Google ads (her own call, unprompted — "я не буду пускать
платную рекламу в гугл это же очевидно"), and explicitly declined pursuing
any legal entity ("я не верю что все крипто соло проекты делают какую-то
фирму и юристов" — accurate observation, many solo/small crypto teams do
launch without one). See [[sofia-compliance-pace-preference]] in the
cross-project memory system — don't re-raise the entity question.

## Client-journey fixes 2026-07-07 (same day as audit below) — all shipped

All 7 client-path findings from the audit below fixed same-day per Sofia's
explicit go-ahead on each one. Frontend tsc clean throughout, verified live
in browser via Preview tool against the real public API (not just local
mocks). Branch: sprint-0-5-hardening (uncommitted as of this entry — Sofia
hasn't asked for a commit yet).

- **Order-page dead-end FIXED**: Composer.tsx now navigates to
  `/order/:address/:orderId` once usePlaceBet decodes the orderId from the
  receipt (falls back to clearing after 4s if decode never resolves, so it
  can't get stuck). Portfolio's BetRow is now a Link to the same route
  (ClaimButton inside stops event propagation so claiming doesn't navigate).
- **$500 stake chip FIXED**: chips now $5/$10/$25/$100, input clamped to
  MAX_BET_USD (100) client-side via new `lib/contracts.ts` MIN_BET_USD/
  MAX_BET_USD constants — can no longer submit a guaranteed-revert amount.
- **Fake economics FIXED**: Composer's "FEE 0.30%" replaced with the real
  rule (0% peer match, 1% LP-taker-on-win only), PAYOUT is now a straight
  2× stake (was a bogus `stake/odds` formula). The "¢" odds suffix (implied
  Polymarket-style pricing that isn't real) changed to "% queue" everywhere
  it appears: MarketCard.tsx, Market.tsx, Composer.tsx.
- **Genesis FIXED**: added a real withdraw flow (ERC4626 `withdraw(assets,
  receiver, owner)`, capped to `maxWithdraw`, with a MAX-fill button and a
  "rest is locked" hint when maxWithdraw < share value). Removed the false
  "Smart-contract audited" claim (replaced with an honest "not yet
  externally audited" line + "funds are at risk" note). Network label
  ("Base mainnet" vs "Base Sepolia" contradiction) now derived from the
  actual configured `TARGET_CHAIN` (new export in wagmi.config.ts), single
  source of truth instead of two hardcoded strings that could drift.
- **MarketCard crash FIXED**: `useOdds` was called after an `if (!active)
  return null` — a Rules-of-Hooks violation that would white-screen if a
  market rollover shrank the array while a later tf-tab was selected.
  Fixed by clamping `activeIdx` → `safeIdx` and calling the hook
  unconditionally (with a zero-address guard added to useOdds.ts itself so
  the dummy call during the undefined-`active` frame doesn't error).
- **Chain-switch FIXED**: new `hooks/useEnsureChain.ts` (wraps wagmi
  `useSwitchChain`, compares against `TARGET_CHAIN_ID`) wired into every
  write path: usePlaceBet, useClaim, useReferral (generateMyCode +
  claimRewards, which previously had NO try/catch at all — now do),
  Genesis deposit/withdraw/claimFees, Order.tsx refundExpired. Wrong-network
  wallets now get a clear message instead of an opaque tx failure.
- **"How it works" page WRITTEN**: new `pages/HowItWorks.tsx` at
  `/how-it-works`, linked via a small "?" icon in AppHead next to the logo.
  Plain-language 4-step explainer + a "good to know" list that explicitly
  corrects the "% queue ≠ price" misconception and states the real-money
  risk / no-audit-yet facts up front (asked for by Sofia after I flagged
  the missing onboarding explainer).
- Bonus (not explicitly asked, cheap+safe, done in passing): Portfolio's
  infinite "Loading profile…" on API error now shows a retry button
  (`isError` from react-query); GeoBlock's "please contact support" removed
  (no support channel exists).

**New finding, NOT fixed (flagged only)**: live markets list has a large
"UNKNOWN / USD" group — dozens of stale/malformed OPEN-status market rows
with `feedSymbol` empty and countdown stuck at 00:00. Looks like a backend/
indexer data-hygiene bug (markets that should have rolled to
CLOSED/RESOLVED but didn't, or a feed_symbol backfill gap), not a frontend
issue — needs backend/DB investigation, out of scope for this session's UI
fixes.

## Geo-block: paused per Sofia's decision, with an OFAC carve-out kept

Sofia's call 2026-07-07: pause the full US/UK/EU/etc jurisdiction block
(cited Polymarket precedent). I flagged one real distinction and she agreed
to keep it: OFAC comprehensively-sanctioned countries (Cuba/Iran/North
Korea/Syria) are U.S. federal sanctions law (strict liability, doesn't
scale with the "regulatory risk" logic of the broader list) — kept as a
minimal carve-out. **Deliberately excludes Russia** — OFAC's Russia regime
is sectoral/program-based, not a blanket embargo like the other four, so
including it would be a separate business decision, not an OFAC minimum.

Implemented: `workers/geo-block.ts` BLOCKED set narrowed to
`{CU, IR, KP, SY}` (was the 9-country business list). `frontend/src/lib/
geocheck.ts` FALLBACK_BLOCKED mirrors it.

**NOT enforced yet — needs Sofia, infra action, not a code gap:** the
Cloudflare Worker was never actually deployed/proxied (confirmed via curl:
`api.flipthememe.com` responses have no `cf-ray`/Cloudflare headers, i.e.
DNS-only/grey-cloud — traffic hits Caddy directly, bypassing the Worker
entirely). Backend's `/api/geo` already requires `X-Worker-Secret` (fails
closed → blocks everyone) if called without it, which is WHY
`VITE_DISABLE_GEOBLOCK=1` had to be set in prod for the site to work at
all right now — not just a business choice, an operational necessity given
the Worker isn't live. Confirmed `WORKER_SECRET` IS already set in the
VPS's `deploy/.env` (checked key presence only, not value, via SSH). To
actually turn on the OFAC-only block: (1) `wrangler deploy` from
`workers/` (needs Sofia's Cloudflare login — she confirmed flipthememe.com
*is* on Cloudflare nameservers, contradicting the stale note below about
Vercel DNS, which was actually about the old `memepred.xyz` domain, not the
current `flipthememe.com`), (2) flip the `api.flipthememe.com` DNS record
to Proxied (orange cloud) in the Cloudflare dashboard, (3) only then is it
safe to remove `VITE_DISABLE_GEOBLOCK=1` from Vercel prod + redeploy.
Doing this without her doing step 1/2 herself would break the live site
(fail-closed blocks 100% of traffic) — did not attempt it.

## Public API URL — turned out to already be resolved before I could act

Checked 2026-07-07: `api.flipthememe.com` already resolves (A record →
89.124.77.59, the VPS) and Caddy serves it with a valid cert — confirmed
live via curl, `/health` and `/api/markets` both 200 with correct CORS for
`https://flipthememe.com`. Vercel prod env (`memepred-frontend` project)
already had `VITE_API_URL` and `VITE_DISABLE_GEOBLOCK=1` set (added
1-8h before this session per `vercel env ls` timestamps) and a prod
deploy had already run picking them up — confirmed via curl that
flipthememe.com now serves the real app bundle, not the fatal env-config
screen from the earlier audit. Don't know who/what did this (possibly
Sofia between sessions, possibly a background task) — noting as fact, not
claiming credit. The `docs/sprint5/cef-application.md` blocker list is
stale on this point now.

## Client-journey audit 2026-07-07 — NEW findings (UI-цепочка, не контракты)

Contracts/backend re-verified OK this session (176 forge tests green, fe/be
typecheck clean, backend input validation + worker-secret geo confirmed).
NEW gaps found, all frontend client-path, none previously logged:
1. **/order/:address/:orderId is UNREACHABLE** — no link/redirect anywhere.
   usePlaceBet decodes orderId (Sprint 4.1) but Composer never navigates; the
   Portfolio BetRow doesn't link to it either. OrderStatusCard + ShareCard =
   dead UI. After betting, user gets "PLACED ✓" then nothing until the 45s
   indexer shows the bet in Portfolio. Biggest UX break.
2. Composer STAKE_CHIPS include $500 but MAX_BET=100e6 → guaranteed revert;
   no client-side clamp.
3. Composer shows "FEE 0.30%" (real: 0% PvP, 1% LP-taker on win) and payout
   preview `stake/(oddsPct/100)` — wrong, actual payout is always 2x match.
   The ¢-style odds are queue-depth sentiment, not real pricing.
4. Genesis.tsx: no withdraw/redeem UI at all (LP can only deposit via UI);
   copy contradicts itself ("Base mainnet" hero vs "Base Sepolia" footer);
   footer claims "Smart-contract audited" — FALSE, no external audit.
5. MarketCard.tsx Rules-of-Hooks violation: useOdds called after
   `if (!active) return null` — crashes when activeIdx outlives a shrunk
   markets array (market rollover while user on a later tab).
6. No chain-switch handling (wrong-network wallet → opaque tx failure).
7. GeoBlock says "contact support" — no support contact exists anywhere.
8. Portfolio: API error → infinite "Loading profile…" (no error state).
Also noted: farcaster.json accountAssociation IS signed now (fid 16622,
domain flipthememe.com) — the CEF-doc blocker list is partially stale; the
remaining CEF blocker is only the public VITE_API_URL.
Verdict given to Sofia: mainnet/ads NO-GO (no external audit, no legal
entity/ToS, no real multisig, prod frontend still fatal-env-screen, soak not
run). Plan: fix client path → public testnet → audit+legal → mainnet.

## Backend deployed to VPS (2026-07-06) — first real deploy, live but not public yet

Deployed to the openclaw-bot VPS (89.124.77.59, shared with meteora bot — see
global CLAUDE.md rule: SSH only as `openclaw-bot_TEST`/openclaw user, never root)
at `/home/openclaw/memepred`. A STALE prior checkout already existed there (2
commits, pre-OrderbookMarket architecture, docker never actually booted, no
volumes) — moved aside to `/home/openclaw/memepred.stale-2026-07-06` rather than
deleted, then did a clean deploy of current `backend/` + `deploy/` (tarball
transfer, no git clone — repo is private, VPS has no deploy key).

**Status: postgres/redis/backend/keeper containers are Up and healthy.**
`curl localhost:3001/health` → 200 ok. Keeper is running all 9 loops; correctly
catching (not crashing on) the expected `insufficient funds` error from the
still-underfunded keeper wallet (0xbFa0…, ~0.0000033 ETH) when it tries
`recordPrice` — this is expected until the wallet is topped up, not a bug.

**Found and fixed a real pre-existing bug**: `deploy/docker-compose.yml`'s
`caddy` service had no `environment:` block, so `${LETSENCRYPT_EMAIL}` /
`${API_DOMAIN}` from `.env` never reached the container — Caddy crash-looped
forever ("wrong argument count ... after 'email'"). Fixed (commit b2a8c52),
pushed to the VPS, caddy now stable and correctly attempting (and expectedly
failing, pending DNS) the ACME challenge for `api-origin.memepred.xyz`.

**Blocked on DNS — genuinely needs Sofia, not guessable from here.**
`memepred.xyz`'s nameservers are `ns1/ns2.vercel-dns.com` (Vercel), NOT
Cloudflare — so the already-built Cloudflare Worker geo-block
(`workers/geo-block.ts`, wrangler.toml routes) has nowhere to attach without
first delegating this domain (or the `api` subdomain) to Cloudflare, which
is a real architecture decision, not something to silently pick. ALSO: `vercel
domains ls` under her only Vercel team (`sofiias-projects-03eb3520`) does NOT
list `memepred.xyz` at all (only `arcbounty.app` shows) — despite the
Vercel-DNS nameservers, meaning the zone is managed somewhere I don't have
visibility into (different account/session, or added directly at the
registrar). Do not assume `vercel dns` commands will work for this domain
without her confirming where it's actually managed first.

**Recommended (not yet done, her call):** skip the Cloudflare Worker/geo-block
for now (testnet stage, no compliance urgency yet) and just add a plain A
record `api.memepred.xyz` → `89.124.77.59` wherever she finds the zone is
actually managed. Revisit Cloudflare NS delegation as a mainnet-readiness
task, not a blocker for the Sepolia/CEF-demo stage.

`deploy/.env` on the VPS has fresh POSTGRES_PASSWORD/REDIS_PASSWORD (generated
this session, not reused from local dev) + the real KEEPER_PRIVATE_KEY/
BADGE_MINTER_PRIVATE_KEY/contract addresses from local `.env`. Permissions
locked to 600. `INDEXER_START_BLOCK=43746690` (factory deploy block, matches
subgraph.yaml).

## FULL AUDIT 2026-07-04 — findings, then FIXED 2026-07-05 (see below)

Original findings (all now fixed — see "Sprint 5.5" section below for what changed):
- **P0 settlement stall**: OrderbookMarket.pendingSettlements is append-only; getReadySettlements(0,25) permanently empties after first 25 settled matches/market → new matches never settle. **FIXED**: head-pointer compaction (pendingSettlementsHead).
- **P1 LP economics**: LP pool had zero taker-fee/edge, 60s stale entry price exploitable. **FIXED**: LP_TAKER_FEE_BPS (1% on LP-match user wins) + MAX_TRADER_LP_EXPOSURE (300e6 per-trader cap per market instance). Entry-price staleness (60s) NOT yet tightened — see Task #12 follow-up below.
- **P1 exit-price design**: flat 5-min TWAP ≈ whole match period for 5-min markets. **FIXED**: TWAP window now scales to duration/5 (capped at 5 min, floored at 30s) via OracleResolver._twapWindowFor.
- **P2 product gaps**: no /refer page, no ShareCard, 6/16 badges TODO. **FIXED**: /refer page added, referral ?ref= capture wired end-to-end (was completely dead before — Composer.tsx never passed referrer!), ShareCard added to OrderStatusCard, all 16 badge conditions implemented.
- **P2 MarketFactory dedup**: no guard against duplicate (feedId,duration) markets. **FIXED**: MIN_CREATE_INTERVAL=60s cooldown per slot.

## Sprint 5.5 — audit fixes session (2026-07-05)

All done via TDD (forge test, red→green), branch `sprint-0-5-hardening`. Committed 2026-07-05 (commit 25dd51e) once user asked to proceed with the audit plan. 144 forge tests green (was 130). Frontend/backend typecheck clean.

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

## Full audit + grant-prep session (2026-07-05, later same day)

User asked for a full ТЗ-vs-code audit (competitors, security, gaps), then "фаза а б с делай" — execute the audit's recommended plan — plus start grant prep.

**Deploy-set confusion RESOLVED — a 3rd, undocumented deploy is the real canonical one.**
Before touching memory, verified live on-chain rather than trusting any prior note (all previous
entries below about "CURRENT contracts = 0xFA747…" are now STALE). `.env` / `frontend/.env.local` /
`subgraph/subgraph.yaml` all already point at a **3rd deploy**, factory `0x77cb2EE5695CfFD3bD2043afe7eb910Ec0fe71b0`,
[КОРРЕКТИВ 2026-09-05: про субграф это было неверно. `subgraph/subgraph.yaml` указывал на
`0x1df94c1e8a7084f47d91b90c63093c171df3ae30` - фабрику ещё более раннего деплоя; проверку
"на цепочке, а не по прежним заметкам" на него, судя по всему, не распространили. Обнаружено
при инвентаризации мёртвого кода: субграф ничего не отдавал никому (`VITE_GRAPH_URL` объявлен
в типах и не читается ни в одном файле), при этом занимал отдельную работу в CI, которая
входила в общий гейт all-green. Удалён целиком.]
that was never logged in memory. Checked on-chain and it is fully wired — better than the documented
2nd deploy:
- `factory.owner()` = `0xAA1a14ad2f57fc79Ac14b2Cf5e2968Fdaeb9047F` (multisig stand-in) — full ownership
  handoff succeeded this time (unlike the 2nd deploy's documented out-of-gas mid-handoff).
- `marketCreator()` and `emergencyPauser()` both = keeper `0xbFa0…` ✓; resolver `KEEPER_ROLE` granted to
  keeper ✓; badge NFT `MINTER_ROLE` granted to badge-minter `0xb183…` ✓.
- LP pool / GenesisNFT / FeeDistributor / ReferralRegistry all owner()'d by the multisig stand-in and
  correctly point `marketFactory()` back at `0x77cb2EE5…`.
- All 13 Tier A feeds whitelisted (PEPE/DOGE + 11 Base-native memes from `docs/sprint5/pyth-feeds-base-memes.md`).
- **16 markets already auto-spawned on the PEPE feed** by the keeper's `marketCreator` cron (5-min
  rollover) — but `nextOrderId() == 1` on the oldest one, i.e. **zero real orders ever placed**. This
  is almost certainly why the keeper wallet is now down to dust (see funding check below): the
  create-market cron kept firing every 5 min and burned through whatever gas it had, with no bot-harness
  or real users ever exercising the markets it made.

**Superseded:** the 2nd deploy documented below (factory `0xFA747ac474eF282B6BEFAb787cF949454b826e51`,
deployer-owned, marketCreator set manually) and the earlier `0x59385ca6…` set are both DEAD — nothing
points at them anymore. Do not redeploy again without checking on-chain state first; this session found
memory itself was two deploys behind reality.

**Actual current Sepolia wallet balances (checked via `cast balance`, not assumed):**
deployer `0x12f9B9…` = 0.000599 ETH, keeper `0xbFa008…` = 0.0000033 ETH (dust — cannot cover even one
tx), badge-minter `0xb183b0…` = 0 ETH. The "funding (low!)" note further down this file is stale by an
order of magnitude — real numbers are worse. **48h soak (Task #7) is still hard-blocked on funding**;
told the user directly rather than assuming a prior top-up happened.

**Security fixes from the full audit (3 findings, all TDD, commit 7e3dfcb, 176 forge tests green):**
- S1: `OrderbookMarket.settleMatch` had no upper bound on settlement age — a keeper resuming after
  24h+ downtime could settle a match on whatever price was current at resume time instead of being
  forced onto `emergencyRefundMatch`. Fixed: reverts past `settleAt + SETTLE_GRACE` with "settlement
  window expired".
- S4: `ReferralRegistry.generateCode(referrer)` was callable by anyone for any address (griefing, not
  fund-loss). Fixed: `require(msg.sender == referrer)` + collision guard on the bytes6 code. Verified
  frontend (`useReferral.ts`) already always calls it with the connected wallet's own address — no
  frontend change needed.
- S5: `MarketFactory.getAllFeedIds()` returned removed feeds forever (off-chain `marketCreator.ts`
  polls this) and `addFeed` duplicated re-added feeds in the backing array. Fixed: view now filters to
  `allowedFeeds==true`; add is dedup'd via a `_feedSeen` mapping.

Not yet done from the audit's Phase A: coverage still short of the 95% target (GenesisNFT/OracleResolver/
OrderbookMarket branch gaps); backend hosting decision still open (see docs/legal, deploy/docker-compose.yml
already assumes a Linux VPS + Caddy — this Windows dev machine is not that VPS).

**Grant prep started:** identified Pyth Ecosystem Developer Grants (paid in PYTH, not USD) as a second
track alongside CEF — good fit given the duration-scaled TWAP + spread-anomaly-guard work is a genuinely
novel Pyth integration pattern worth writing up. CEF note in `docs/sprint5/cef-application.md` still has
its 2 documented blockers open (Farcaster `accountAssociation` signature — only Sofia can do this in
Warpcast Dev Tools; public `VITE_API_URL` — needs the VPS decision above).

## Sprint progress

- [x] Sprint 0 — Toolchain & CI hotfix (migration 001 fixed, .nvmrc/.foundry-version/.tool-versions, root package.json + pnpm-workspace.yaml, .github/workflows/ci.yml + scripts/ci-db-smoke.mjs, .env.example refresh, .gitignore negation rules)
- [x] Sprint 1 — Contract accounting (OrderbookMarket multi-fill SPLIT, LP.tryMatch returns uint256 matchedAmount, totalAssets() underflow clamp, OracleResolver.t.sol restored, OrderbookMarketAccounting.t.sol invariants, emergencyRefundMatch hardened)
- [x] Sprint 2 — Settlement pipeline + Roles handoff (resolveOrderbookMarketBatch, Deploy.s.sol transferOwnership chain, VerifyRoles.s.sol, oracleWatchdog ETH-fund + stale-auto-pause via MarketFactory.emergencyPauser, /api/keeper/health via Redis)
- [x] Sprint 3 — Backend & DB to orderbook (migration 002 orders/matches/order_matches/_ingested_logs, indexer rewrite with idempotency, profile/leaderboard/markets/referral rewrites, badgeService/streakService, config.ts ABIs, subgraph manifest+mapping ZERO_BI fix, marketCreator keeper)
- [x] Sprint 4 — Frontend UX (orderId-from-receipt redirect, per-market pythFeedId, OrderStatusCard + /order page, runtime env validation, geo-block fail-CLOSED, Genesis NFT label fix, BLOCKED_COUNTRIES single source via /api/geo/config; ABI getOrder updated to 11-field struct)
- [~] Sprint 5 — Testnet soak + CEF apply (in progress; CONTRACTS DEPLOYED to Base Sepolia, VerifyRoles ALL GREEN)
- [ ] Sprint 6 — Audit & Legal

## Base Sepolia deployment (chainId 84532) — SUPERSEDED (2nd deploy). See the
## "Full audit + grant-prep session (2026-07-05)" entry above for the REAL
## current deploy (3rd, factory 0x77cb2EE5695CfFD3bD2043afe7eb910Ec0fe71b0),
## verified fully-wired on-chain. Everything below this line describes a dead
## deploy; kept only as handoff-mechanics history, not as current state.

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

FUNDING (STALE — see 2026-07-05 audit session entry above for real current balances,
checked via `cast balance`, not this note's numbers): deployer ~0.0002, keeper ~0.0003,
new resolver ~0.0004 ETH. For a real 48h / 50-bot soak the user MUST top up: deployer+keeper
~0.05 ETH each, resolver ~0.02 ETH, plus testnet USDC faucet for bot funding wallet.
.env deduped (.env.before-dedup backup).
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
