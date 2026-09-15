# Заявка на Arbitrum Open House Singapore - черновик

## Для тебя (не копировать в форму)

**Сроки** - сверено на hackquest 11.09, время твоё местное (UTC+2), как его показывает сайт:

| | |
|---|---|
| Регистрация | до **2 октября 19:01** |
| Приём работ | **13 сентября 19:01 - 4 октября 17:59** (это 23:59 по Сингапуру) |
| Итоги | 12 октября 08:00 |
| Founder House | 23-25 октября, Сингапур, очно. **Отдельная заявка** на `https://luma.com/openhouse-singapore`, рассматривают по мере поступления. Победители buildathon попадают туда гарантированно |

**Призы:** основной трек 70 000 USDC (40 / 20 / 10 тысяч), Promising Products 15 000 USDC
(7 / 5 / 3 тысячи), гранты до 30 000 USDC на усмотрение фонда. **В обоих треках минимум одно
место из трёх зарезервировано под проект на Robinhood Chain.** Призы выплачивают по вехам
разработки. Участников 615+ на 11.09.

**Требование:** проект развёрнут на цепочке Arbitrum, и Arbitrum Sepolia названа прямо - то
есть тестнет допускается, мейннет не обязателен. Засчитывается ли тестнет Robinhood Chain
под зарезервированное место, прямо не написано; это стоит спросить у организаторов.

Подаём в **Promising Products**.

**Тексты для формы регистрации** (длина проверена, лимит поля 300 знаков):

- *Do you already have an idea…* (274 знака):
  `Yes. FlipTheMeme on Robinhood Chain: short up/down bets on graduated memecoins, staked in ETH and settled from each token's own Uniswap v3 TWAP. Contracts are deployed and soak-tested on RHC testnet; the buildathon is for a fixed redeploy, the public web flow, and the demo.`
- *Do you already have a project…* (234 знака):
  `Yes, FlipTheMeme. The Robinhood Chain prototype is deployed on RHC testnet (46630); one of its markets, with the soak test's settled bets: https://explorer.testnet.chain.robinhood.com/address/0x9afAFFAFC3c01BAEF489E9bFE8BB09C455f21BB8`

**Что нужно от тебя:**

1. Регистрация - **сделана 11.09**. Дальше - создать проект на hackquest (кнопка Create Project
   уже доступна) и сдать его до 4 октября 17:59.
2. Репозиторий приватный. Контракты жюри увидит в обозревателе тестнета **с исходным кодом** -
   они верифицированы 11.09; бэкенд и фронтенд - только если откроешь репозиторий или дашь
   доступ по запросу.
3. Кошелёк Arbitrum One для призов - твой собственный, не адрес депозита на бирже.
4. Демо-видео - к сдаче 4 октября.
5. Команда: ниже написано «solo founder, AI-assisted engineering». Поменяй, если хочешь иначе.

Ниже текст на английском, разбит по обычным вопросам такой формы.

---

## Project name

FlipTheMeme

## One-liner

Short, capped up-or-down positions on Robinhood Chain memecoins: staked in ETH, priced by each
token's own Uniswap v3 pool, settled 1 to 15 minutes after the bet is matched.

## In one paragraph

FlipTheMeme lets Robinhood Chain memecoin communities take a time-limited view on a token
without buying it. The stake and the maximum payout are shown before entry, and every result
can be checked on chain against a published pool-price rule. It is a working prototype on
Robinhood Chain testnet, built on a settlement engine we have been developing and testing
since March 2026.

## The problem

Robinhood Chain trades about $1.9B a day on its DEXes (DefiLlama, 11 September), and much of it
is launchpad tokens that did not exist a week earlier: our own scan of the Uniswap v3 factory
found 496 new pools in a single day. Nearly everything built around that flow is a way to buy
the token. A bounded, short-dated view - "does this hold for the next five minutes" - without
holding the token is barely served, and it cannot be built on a price feed, because no feed
carries a token that graduated an hour ago.

## What we are building

Two traders take opposite sides of "token X will be higher in N minutes than when we matched".
Each stakes ETH into a market contract, and the winner takes the pot minus a protocol fee capped
at 1%. It is peer-to-peer first. When the book is one-sided, an LP vault can take the other
side, capped at 5% of the vault's assets per market and 10% overall - so the vault does carry
directional risk, and it is sized for that rather than pretending otherwise.

**The token's own pool is the oracle.** Entry and exit prices are time-weighted averages read
with `observe()` straight from the token's Uniswap v3 pool. There is no feed to wait for, no
keeper paying to push prices, and no list of supported assets: any WETH pool that clears the
on-chain gates can host a market, and anyone can create it.

That has a known catch, which we measured on live pools rather than assumed. A new pool stores a
single price observation (288 of the 292 WETH pools created in the day we scanned), so it cannot
answer for a window until someone pays to grow its observation ring. Uniswap writes at most one
observation per second, so ring slots buy seconds, not blocks. The longest exit window we use is
180 seconds, and the ring also has to cover how late a settlement runs - 65 seconds at the 99th
percentile across 148 real settlements - so we require 300 slots. Growing a ring to 300 costs
6,655,224 gas once per pool, about $6.60 at early-September gas, measured on a live pool.

The second half of the catch surprised us, and a fork test against live mainnet pools is how we
found it: a pool whose newest observation is older than the window does not refuse - Uniswap
extrapolates it forward at the current price. A successful `observe()` therefore proves
capacity, not history. What keeps a thin pool out is the depth gates, not the oracle.

**No rounds and no schedule.** Our market contract has no close time: a match's clock starts when
it is matched. One market per pool and duration is created once and lives indefinitely, so a
trader never waits for the next round, and nothing has to be rolled over or pushed on a timer.
Markets remain permissionless for PvP; the vault owner separately enables the few reviewed
markets allowed to draw on shared LP capital.
What remains is settlement gas per match, a one-off onboarding cost per pool, RPC and hosting.
Over a 24-hour sample of 1,900 points, gas sat at a median of 0.398 gwei and a 90th percentile of
0.453, with rare four-minute spikes to 3.06 and no daily cycle.

**Fees you can verify.** The protocol fee is capped at 1% of the pot by a contract constant that
cannot be raised, and any change for future markets goes through a 48-hour timelock; each market
keeps the fee it was created with. We ran that timelock end to end on the deployed testnet
factory: proposed on 5 September, applied on 11 September, `feeBps` moved 0 to 100. To be
complete about what a user pays: a trader who wins against the LP vault pays a further 1%, and
every transaction pays gas. One gap the timelock run exposed and we have since closed in code,
not yet redeployed: new markets started at 0% until governance completed its first change, so a
permissionless caller could occupy a slot at zero fee before that ever happened - fixed by
snapshotting the fee cap itself at creation instead.

## Why Robinhood Chain

- The flow is here and it is already in ETH: launchpad curves and pools are token/ETH, so a bet
  in ETH needs no bridge or swap first.
- Markets arrive without anyone listing them. In one day the v3 factory created 496 pools, 292 of
  them paired with WETH and 169 with liquidity. The median graduated pool holds 1.5 ETH. Anyone
  can open a market on a pool with at least 2 ETH of depth; our own keeper pays to onboard pools
  from 20 ETH, about seven a day.
- Blocks every 82 ms make one-minute settlement meaningful rather than theatre.
- We are explicit about coverage. On DefiLlama, Uniswap v3 and v4 each show about $1.1B of
  24-hour volume on this chain (11 September). Our oracle reads v3 WETH pools; tokens that trade
  only on v4 need a separate price source, and we treat that as its own project, not a footnote.

## What exists today on Robinhood Chain

Deployed on Robinhood Chain testnet (46630) on 5 September. The testnet has no canonical Uniswap
v3 or WETH, so there the markets run against stand-in pools that integrate the price over time
and refuse out-of-range windows the way real ones do. Against the real pools on mainnet 4663 we
use fork tests.

- **Contracts:** `PoolOracleResolver` (v3 TWAP), `PoolMarketFactory` (permissionless creation
  behind on-chain gates), `PoolOrderbookMarket` (EIP-1167 clones, partial fills, WETH stakes), an
  LP vault with exposure caps, a fee distributor and a referral registry, all source-verified on the testnet explorer.
  **357 Foundry tests** at
  commit `837dfb4` on 11 September: 276 are the original engine's suite and pass unchanged, and 9
  exercise live Robinhood Chain mainnet pools - they need an RPC, and without one they return
  early, so an offline run counts them as passing.
- **Against real mainnet pools:** on a fork of chain 4663 the resolver prices live pools
  correctly, and `createMarket` creates a real market on a live pool (RMHT) through every gate.
  Our vendored `TickMath` is checked against 224 `(tick, sqrtPriceX96)` pairs read off live pools.
- **A 47-hour soak** (5-7 September): 1,113 orders and 278 matches, 56 of them against the LP
  vault, with settlements, claims and refunds. Two paths that had never run anywhere were then
  exercised on chain: the emergency refund of a match that cannot be priced - both sides got
  their stake back exactly - and the fee timelock.
- **An invariant monitor** reconciles contract balances against our database every minute. Over
  the soak it raised 56 critical alerts, and not one was money that was actually missing: 46 were
  the indexer lagging in the safe direction, 8 predate a decimals fix, and 2 were balance reads
  that timed out and were counted as zero - a monitor bug, since fixed. The final snapshot matched
  the chain to the wei.
- **Backend and keeper:** event indexer, a pool watcher that onboards new pools unaided, a
  settlement keeper with nonce escalation and a gas budget, a watchdog. **272 unit tests.**

The web betting flow now reads the same PoolOracleResolver TWAP as the contract, submits an
ordinary RHC call without a RedStone payload, uses WETH bounds, shows market-specific fees and
states that queue counts are not odds. It still needs an end-to-end wallet test on RHC testnet.

## What testing found

Running the system found defects no unit test had, every one of them in code written for the
original single-chain version: amounts divided by the wrong currency's decimals in the indexer
and the monitor, a partially filled order that never left `PENDING`, payouts that were never
recorded, and a watchdog that paused every market on the chain. The subtlest was a constant:
`MIN_DEPOSIT = 50e6` meant fifty dollars in USDC and became dust on an 18-decimal token, which
would have let one address take all twenty Genesis LP NFTs - each worth 1.5x fee weight for the
life of the vault - for a gwei. It is fixed, and the test that guards it performs the attack on
both versions of the vault.

## What we will ship during the buildathon (13 September - 4 October)

**Week 1 - the Robinhood Chain web flow.** Done in code: price bets come from the pool oracle,
calls use the RHC path, amounts use the 0.005-0.04 WETH range, and the preview includes the
market fee plus the LP fee. The acceptance check remains a fresh-wallet bet and claim on RHC
testnet.

**Week 2 - settlement rules and economics.** Done in code, pending a testnet redeploy: a tie
refunds both sides, every settled match has a minimum lot, and PvP creation no longer
authorizes LP capital by default - the vault owner opts each reviewed market in separately. The
same pass fixed two ways the settlement queue could jam behind one unpriceable match (a batch's
gas limit now scales with its size instead of a fixed ceiling too small for a busy tick; an
overdue match is now swept into the permissionless emergency refund automatically) and closed a
window where a resting order could be filled at a stale one-second price. Remaining economics
work is to monitor the RHC gas reserve at low volume. The RHC-specific distributor sends 90% of
protocol fee to treasury reserve and 10% to a referrer; Base keeps its original split.

**Week 3 - public demo and submission.** A public testnet deployment with external monitoring,
three to five selected active v3 tokens, a demo video, the submission. A capped mainnet pilot
only if our own criteria are met first: multisig ownership, working external monitoring, a hard
limit on total risk, and a launch order in which the fee is set before any market can be created
- markets snapshot the fee at creation, and creation is permissionless. Otherwise we submit an
honest testnet demo.

## Track

Promising Products (new financial primitives), building on Robinhood Chain.

## Team

Sofia - founder, product and engineering. Solo founder with AI-assisted engineering; the
contracts, tests and operations above are the output of that setup since March 2026.

## Links

- A five-minute market with the soak's settled bets, on the Robinhood Chain testnet explorer (an
  EIP-1167 clone of the source-verified `PoolOrderbookMarket`):
  https://explorer.testnet.chain.robinhood.com/address/0x9afAFFAFC3c01BAEF489E9bFE8BB09C455f21BB8
- The market factory (source verified):
  https://explorer.testnet.chain.robinhood.com/address/0xE5802e3e9aB5dEFE7F133543Bc90b5893aD75a42
- Repository: private today, access on request.
- Decisions, measurements and deployed addresses: `docs/rhc/` (`DECISIONS.md`, `measurements/`,
  `DEPLOYMENTS.md`).

## What the prize and the Founder House would be used for

An audit of the oracle and settlement path. The contracts are tested but unaudited, which is why
stakes are capped at 0.04 ETH per bet; prizes paid against development milestones suit that work.

## Risks we state plainly

- A thin pool can be moved within a short averaging window. The contract requires 2 ETH of depth,
  our keeper only onboards pools from 20 ETH, spread checks refund an anomalous settlement, and LP
  exposure is capped. A cap on open interest tied to the pool's own liquidity is not designed yet.
- The entry price averages the 60 seconds before the match. When the price moves just before
  entry, the live price is known while the average lags, which can give a trader an edge against
  the vault's fixed-payout side. We will measure this on active pools before real money.
- Both spread checks read the same pool, so they are not independent sources, and an ordinary
  memecoin move can trip them. We will measure the refund rate rather than raise the threshold
  blind.
- Tokens that trade only on Uniswap v4 are out of reach of the v3 oracle.
- Settlement gas is paid per match, and gas moved eightfold within a single day in early
  September.
