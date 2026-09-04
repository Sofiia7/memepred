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
catch on live Robinhood Chain pools: new v3 pools ship with `observationCardinality = 1`,
so `observe()` reverts `OLD` and then returns a spot tick rather than a TWAP. Our factory
calls `increaseObservationCardinalityNext(60)` once per pool (1,352,756 gas, about $6 at
current congestion pricing), after which a 30-second to 5-minute TWAP is free to read
forever.

**No rounds, and no market schedule.** Our market contract has no close time: a match's
settlement clock starts when it is matched, not when a window ends. So one contract per
token lives indefinitely, created once, and a trader never waits for the next round. This
also removes the entire recurring cost: there is no rollover to pay for and no price to
push. The only variable expense left is settlement gas, which is proportional to matches,
which is proportional to revenue. On a chain where execution gas is ~1.8 gwei and rising
with congestion, moving cost from the calendar to the trade is the difference between a
business and a burn.

**Fees you can verify.** The protocol fee is capped at 1% of the pot by a contract
constant, taken only on settlement, changeable only through a 48-hour timelock that emits
a public event, and snapshotted into each market at creation so an open position always
settles on the terms it opened under. Against a 10% creator tax or a 2% bot round trip
with 9.5% slippage, "1%, and here is the constant that stops us raising it" is the pitch.

## Why Robinhood Chain, specifically

- 99.5% of the chain's DEX volume goes through one Uniswap deployment, so a single oracle
  surface covers the whole market. 138 new v3 pools a day, 75% with liquidity, is a steady
  supply of markets without us listing anything.
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
  Timelocked fee changes, bounded emergency pause, multisig-gated admin. **276 Foundry
  tests.**
- **Backend and keeper:** event indexer, market spawner, settlement keeper with nonce
  escalation and a gas budget, an invariant monitor reconciling on-chain balances against
  the database, watchdog with deep health checks. **222 unit tests.**
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

## What we will ship during the buildathon (Sept 14 - Oct 4)

**Week 1, contracts.** Resolver reads Uniswap v3 `observe()` instead of a push feed;
markets denominated in WETH with new min and max bet; `createMarket(pool, duration)`
becomes permissionless behind on-chain gates (min liquidity, cardinality >= 60, allowed fee
tiers). Measure settlement gas, single and batched, because it sets the minimum bet. Fork
tests against real Robinhood Chain pools. Deploy to testnet 46630.

**Week 2, services.** Keeper watches the v3 factory's `PoolCreated` over WebSocket, applies
the gate, enables cardinality, spawns one market per token. Rollover and price-push loops
are deleted. Indexer derives symbols from pool tokens. Frontend: 18-decimal ETH, a live
feed of graduating pools. A 48-hour bot-driven soak on 46630.

**Week 3, mainnet and submission.** Deploy to chain 4663 with a 0.04 ETH per-bet cap (the
same "small money until audited" posture we run today), propose the 1% fee early enough for
the 48-hour timelock to mature before submission, watchdog on the new endpoints, demo
video, submission.

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
- Design note written for this buildathon: `docs/robinhood-chain-pivot.md`

## What the prize and the Founder House would be used for

Audit budget. The contracts are tested but unaudited, which is why bets are capped. The
Promising Products prize and a Founder House slot go toward a scoped audit of the oracle
and settlement path so the cap can come off.

## Risks we state plainly

Thin memecoin pools can be moved inside a short TWAP window. We mitigate with
cardinality-60 TWAPs rather than spot, spread-anomaly refunds, LP exposure caps, and a
per-market open-interest cap tied to the pool's own liquidity, and we say so in the UI.
Uniswap v4 pools hold most of the chain's volume and expose no oracle, because a pool's
hook is fixed at creation and the incumbent launchpad's hook records no observations; v3
is phase one and v4 needs either a launchpad-side hook or a keeper-computed TWAP. Settlement
gas on this chain is not yet measured and sets the minimum viable bet.
