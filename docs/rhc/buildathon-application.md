# Заявка на Arbitrum Open House Singapore - черновик

## Для тебя (не копировать в форму)

Регистрация: `https://arbitrum-singapore.hackquest.io/` (ссылка из блога фонда Arbitrum).
Буилдатон онлайн **14 сентября - 4 октября**, $115K, 382+ участника на момент проверки.
Треки: Open ($70K, три места) и Promising Products ($15K, три места, «AI-агенты, новые
финансовые примитивы»). В **каждом** треке минимум одно место из трёх зарезервировано под
проект на Robinhood Chain. Плюс $30K дискреционных грантов фонда. Существующий проект
разрешён прямым текстом: «builders can develop an existing project or codebase».

Подаём в **Promising Products**: конкурируем за одно зарезервированное место из трёх, а не
за три из всего пула.

Что нужно от тебя, я это заполнить не могу:

1. **Репо приватный** (`github.com/Sofiia7/memepred`). Жюри должно что-то увидеть.
   Варианты: открыть репо; публичный мирроринг ветки без секретов; доступ по запросу.
   Секретов в коде нет (`docs/SECRET-ROTATION.md`), но перед открытием проверить
   `.gitignore` на `.env` и `.testwallets/`.
2. Имена, роли, контакты, страна, кошелёк для призов - обязательные поля формы.
3. Как формулировать команду. Ниже «solo founder, AI-assisted engineering» - честно и
   в 2026 читается нормально. Поменяй, если хочешь иначе.
4. Демо-видео - к сдаче 4 октября, не к регистрации.

Ниже текст на английском. Поля hackquest скрыты за логином, поэтому разбито по обычным
вопросам такой формы; при заполнении перекладывай по смыслу.

---

## Project name

FlipTheMeme

## One-liner

Continuous up-or-down markets on freshly graduated launchpad tokens, priced by the token's
own Uniswap v3 pool, settled 1 to 15 minutes after your bet is matched, staked in ETH, on
Robinhood Chain.

## The problem

Robinhood Chain launches about 25,000 tokens a day and does $1.7B of DEX volume, almost
all of it on tokens that did not exist last week. For all of that flow there is exactly one
thing you can do with a token: buy it. You cannot short a graduation pump, hedge a bag you
already hold, or take a 60-second view on "does this survive" without owning the token.
The derivative layer every mature market has does not exist for launchpad tokens, because
no price feed has heard of a token that graduated an hour ago.

The cost of expressing a view is also opaque. A round trip through a bot is 1% in, 1% out,
plus auto-slippage that defaults to 9.5%, plus a per-token creator tax that launchpad
contracts allow up to 10% per trade. Traders on this chain report the same round trip
costing $1, $4, or $10 with no visible reason.

## What we are building

FlipTheMeme is a non-custodial peer-to-peer market: two traders take opposite sides of
"token X is higher than now in N minutes", stake ETH into a market contract, and the winner
takes the pot. No house inventory, no order flow sold to a market maker. The LP vault only
backstops one side when the book is unbalanced, capped at 5% of TVL per market and 10%
globally.

**Pricing: the token's own pool is the oracle.** Entry price at match time and exit price
at settlement are `observe()` TWAPs read straight from the token's Uniswap v3 pool. No feed
to wait for, no keeper pushing prices, no whitelist of supported assets. Any pool that
clears an on-chain liquidity gate can have a market, permissionlessly. We measured the
catch on live Robinhood Chain pools, and it has two halves. New pools ship with
`observationCardinality = 1` - 288 of the 292 WETH pools created in a day we scanned - so
`observe()` reverts `OLD`. Growing the ring costs 6,732,246 gas once per pool, after which
the TWAP is free to read forever.

The second half is the one worth knowing. Uniswap writes at most one observation **per
second**, not per block, so ring slots buy seconds rather than blocks. On an 82ms chain
that inverts the intuition: we measured 2.88 seconds of history per slot on live pools,
which makes 60 slots worth 173 seconds against the 180 a 15-minute market's exit window
needs, and 60 seconds flat if the pool is trading every second. And a full ring is not the
same as real history - Uniswap raises `cardinality` to `cardinalityNext` in a single step
on the first write after payment, so a pool can report 300 slots while holding two seconds
of prices. Our factory therefore gates on 300 slots **and** on the pool actually answering
`observe()` for that market's own window, which has a pleasant side effect: a young pool
earns its 60-second market before it earns its 15-minute one.

**No rounds, and no market schedule.** Our market contract has no close time: a match's
settlement clock starts when it is matched, not when a window ends. So one contract per
token lives indefinitely, created once, and a trader never waits for the next round. This
also removes the entire recurring cost: there is no rollover to pay for and no price to
push. The only variable expense left is settlement gas, which is proportional to matches,
which is proportional to revenue. Execution gas here is priced by congestion and has to be
read from the `ArbGasInfo` precompile rather than `eth_gasPrice` - the latter under-reports
by about four times, which we found by measuring both. Over a 24-hour sample of 1,900
points the real price sat at a p50 of 0.398 gwei and a p90 of 0.453, with rare four-minute
spikes to 3.06 and no daily cycle at all. Moving cost from the calendar to the trade is the
difference between a business and a burn.

**Fees you can verify.** The protocol fee is capped at 1% of the pot by a contract
constant, taken only on settlement, changeable only through a 48-hour timelock that emits
a public event, and snapshotted into each market at creation so an open position always
settles on the terms it opened under. Against a 10% creator tax or a 2% bot round trip
with 9.5% slippage, "1%, and here is the constant that stops us raising it" is the pitch.

## Why Robinhood Chain, specifically

- 99.5% of the chain's DEX volume goes through one Uniswap deployment, so a single oracle
  surface covers the whole market. Our own 24-hour scan of the v3 factory: **496 pools
  created, 292 paired with WETH, 169 of those with liquidity** - a steady supply of markets
  without us listing anything. The median graduated pool holds 1.5 ETH and the launchpad's
  standard graduation sits at 12.45, which is what our depth gate is calibrated against.
- The users are here and already in ETH: launchpad curves are ETH-denominated, pools are
  token/ETH, one Telegram bot alone routes $445M a day. Betting in ETH removes the
  bridge-and-swap step that kills conversion.
- Stock-paired memecoins (432 pools, $95M/day against tokenized NVDA, TSLA, AAPL) are a
  market type that exists nowhere else. A 60-second up/down on a meme priced against NVDA
  is a product no other chain can offer.
- 82ms blocks and sub-second soft confirmations make one-minute settlement meaningful
  rather than theatre.

## What already exists (built, tested, running)

Not a hackathon idea. In development since March 2026, running today on Base Sepolia at
flipthememe.com:

- **Contracts:** EIP-1167 cloned markets, orderbook matching with partial fills,
  TWAP settlement with two independent spread anomaly checks and emergency refunds,
  ERC-4626 LP vault with exposure caps, fee distributor with referral split, badge NFTs.
  Timelocked fee changes, bounded emergency pause, multisig-gated admin. **357 Foundry
  tests**, of which 276 are the Base suite and pass unchanged - the Robinhood Chain build
  is additive, not a fork - and 9 run against live Robinhood Chain mainnet pools.
- **Backend and keeper:** event indexer, market spawner, settlement keeper with nonce
  escalation and a gas budget, an invariant monitor reconciling on-chain balances against
  the database, watchdog with deep health checks. **272 unit tests.**
- **Frontend:** React, wagmi, viem, mobile-first, Coinbase Smart Wallet and MetaMask.
- **Ops:** dockerised stack on a VPS behind a Cloudflare Worker edge (geo-block with an
  OFAC layer), external cron watchdog, Telegram alerting, database backups, dependency
  audit in CI. Full PvP cycles (place, match, settle, claim) have settled on-chain.

What running it taught us: the original design had the keeper pay for prices (a push feed
every 30 seconds) and roll a market matrix on a schedule. Both are the wrong shape for a
chain where new assets arrive by the thousand and gas is priced by congestion. Reading
our own contract carefully during this buildathon's design work showed the market has no
close time at all, so the rollover was a keeper policy rather than a requirement. Removing
it is most of the rebuild.

What the soak taught us is worth saying too, because it is the part most projects leave
out. Running the thing found eight defects that no test had, and every one of them lived in
code written for Base. The soak harness had been fetching prices from an oracle that was
replaced months ago and passing an address where a signer was expected, so it had never
placed a single bet - which is why this protocol had six orders in its entire history and
not one match carried to payout. The indexer divided amounts by the wrong currency's
decimals; the invariant monitor did the same and reported a trillion-fold drift; a
partially filled order never left `PENDING`, so its payout dropped out of the accounting;
and the watchdog, asking a price gateway for a symbol decoded out of a pool address, paused
every market on the chain. That last one is the good news inside the bad: the emergency
stop worked exactly as designed, for the first time on a live chain.

## What we will ship during the buildathon (Sept 14 - Oct 4)

Weeks 1 and 2 are already done, ahead of the window. What follows is what was actually
built and what is left, not a plan.

**Week 1, contracts - done.** `PoolOracleResolver` reads Uniswap v3 `observe()` instead of
a push feed. `PoolOrderbookMarket` stakes WETH, and its minimum bet is derived rather than
chosen: the protocol may take at most 1% of a pot that is twice one stake, settlement costs
137,926 gas of marginal work per match measured on chain, so break-even is 50x the gas
price and the floor lands at 0.005 ETH. `createMarket(pool, duration)` is permissionless
behind on-chain gates, one test per gate. Deployed to testnet 46630.

Fork tests against real pools looked impossible at first: the public RPC keeps 8.4 minutes
of state, so a pinned block cannot be replayed - we binary-searched it. A fork at `latest`
does work, and it is now the strongest test we have: **`PoolOracleResolver` prices live
mainnet pools, and `createMarket` creates a real market on a live pool, through every
gate.** It also corrected us. We had asserted that a pool holding a single observation must
refuse to price. It does not: `observe()` extrapolates forward from a stale newest
observation at the current tick, which is correct, and which means the ring-size gate buys
future history rather than present observability - it is the depth gates that keep a thin
pool out. Alongside it, our vendored `TickMath` is checked against **224
`(tick, sqrtPriceX96)` pairs read off live mainnet pools**, so agreement is evidence rather
than self-consistency. Without a pinned block these cannot run in CI; they run on demand,
against the chain as it is.

**Week 2, services - done.** The keeper watches `PoolCreated` by polling rather than over a
websocket, and that turned out to be the better fit: the watcher needs a durable cursor
either way, and once it has one a subscription only saves latency it does not need, since a
pool is not tradeable the second it exists. The rollover and price-push loops do not start
on this profile at all. On chain, unaided:

    [poolWatcher] 1 new WETH pools
    [poolWatcher] 0xc916... READY: depth 50.000 ETH, cardinality 300
    [poolWatcher] 0xc916... created 60s market
    [poolWatcher] 0xc916... created 300s market
    [poolWatcher] 0xc916... created 900s market

The soak ran just under 47 hours, in two runs around a machine reboot: 1,113 orders, 278
matches (56 of them against the LP vault), settlements, claims, refunds, and the one
emergency refund path that had never run on any chain. The invariant monitor raised 56
critical alerts along the way and **not one of them was money that was actually missing**:
46 were the indexer lagging in the safe direction, 8 predate a decimals fix, and 2 were
balance reads that timed out and were counted as zero - a monitor bug, since fixed. The
final snapshot matched the chain to the wei.

**Week 3, mainnet and submission.** Deploy to chain 4663 with a 0.04 ETH per-bet cap (the
same "small money until audited" posture we run today), propose the 1% fee early enough for
the 48-hour timelock to mature before submission, watchdog on the new endpoints, demo
video, submission. The deploy script refuses to run against 4663 without handing every role
to the multisig, so the testnet convenience cannot become a launch mistake.

## Track

Promising Products (new financial primitives), building on Robinhood Chain.

## Team

Sofia, founder, product and engineering. Solo founder with AI-assisted engineering; the
codebase, tests and ops above are the output of that setup over six months.

## Links

- Live testnet: https://flipthememe.com
- Keeper and health status: https://api.flipthememe.com/api/keeper/health
- Repository: https://github.com/Sofiia7/memepred (private today, access on request /
  will be opened for judging)
- Design note: `docs/rhc/pivot-design.md`; specification: `docs/rhc/TZ.md`
- Every number above, with its method and raw data: `docs/rhc/measurements/`
- Deployed addresses on testnet 46630: `docs/rhc/DEPLOYMENTS.md`

## What the prize and the Founder House would be used for

Audit budget. The contracts are tested but unaudited, which is why bets are capped. The
Promising Products prize and a Founder House slot go toward a scoped audit of the oracle
and settlement path so the cap can come off.

## Risks we state plainly

Thin memecoin pools can be moved inside a short TWAP window. We mitigate with
300-slot TWAPs rather than spot, spread-anomaly refunds, LP exposure caps, and a per-market
open-interest cap tied to the pool's own liquidity, and we say so in the UI - in the
blocking disclosure a user has to acknowledge before their first bet, not in a footnote.
Uniswap v4 pools hold most of the chain's volume and expose no oracle, because a pool's
hook is fixed at creation and the incumbent launchpad's hook records no observations; v3
is phase one and v4 needs either a launchpad-side hook or a keeper-computed TWAP.

Settlement gas is now measured and it is less forgiving than we assumed: batching removes
19%, not the several-fold we had expected, because the cost is per-match storage writes.
That sets a $12 minimum bet at today's gas, and Robinhood's gas subsidy ends in late
September - during this buildathon - which is the one known event that moves it.
