# FlipTheMeme — Arbitrum Open House Singapore application

Draft checked 2026-10-03 for the deployed **PoolRounds** testnet product. The public rounds release is live, and a browser-wallet ETH stake, settlement and collection have been verified. Before submission, Sofia must open the repository and upload the final video to an accessible URL. Copy the English sections into the HackQuest project form, adapting to its actual fields. This document does not record a HackQuest submission. A [one-page English entry point](../../README.md) is available for judges.

The [published buildathon page](https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon) accepts an existing project deployed on an Arbitrum chain; Robinhood Chain is named as an example, and Arbitrum Sepolia establishes that testnet deployment can qualify. The page does not explicitly confirm whether **Robinhood Chain testnet** receives the Robinhood-reserved prize. Submission closes **4 October 2026, 23:59 Singapore time** (**17:59 Belgrade / Budapest**, UTC+2). The official timeline stores `2026-10-04T15:59:00.000Z`. Registration was completed 11 September. The proposed track is **Promising Products**.

## Project name

FlipTheMeme

## One-liner

Short UP/DOWN rounds for people who enjoy outcome betting and want a market on the Robinhood Chain meme coin they actually follow. Traders stake test ETH in one transaction; matched stakes settle against that coin's on-chain pool price.

## What problem does it solve?

People who enjoy Polymarket-style outcome bets often cannot find a short UP/DOWN market on the particular Robinhood Chain meme coin they follow. FlipTheMeme lets them take that view without buying or shorting the coin. Each eligible coin's own v3 pool supplies the price rule, so a separate listed price feed is not needed. The contract accepts equal stakes on both sides, shows the totals before a bet, and limits an active bank by pool depth. A round needs real opposing stakes to activate; that is the product's main liquidity constraint.

## How does the current product work?

Each 5-minute round accepts public UP and DOWN stakes of 0.005–0.04 test ETH per wallet. The contract wraps ETH internally into a redeemable WETH, so the wallet needs no swap or token approval. Only the smaller side's total plays on each side, with larger-side excess refundable without a fee. A matched bank below 0.01 WETH does not activate (two minimum stakes on opposite sides play); every stake in that round is refundable in full. A pool must clear the contract's depth and observation gates, and the bank cannot exceed pool depth divided by 2,500. The demo has three listed tokens.

After betting closes, a 5-minute pause starts. The strike is averaged over the following minute; the exit is measured 5 minutes after the strike window ends. The result is due about 11 minutes after betting closes, 16 minutes after the round opened. A trader is betting on the move **from the future strike to the exit**, not on the displayed price at entry. A winner receives 1.96× the accepted portion of their stake, plus any unmatched portion. The contract retains 2% of the matched bank when it produces a winner. A tie or an active round that cannot be priced returns the matched stakes minus 1%. Players press **Collect** to receive ETH winnings or refunds; gas is separate.

The round contract reads both price windows from the token pool's on-chain observations. Anyone can verify the result, call settlement when due, and collect their own position. A keeper normally fixes the strike and settles within contract-reported deadlines. Public health checks and an external watchdog monitor that path.

## Why Robinhood Chain?

Launchpad tokens on Robinhood Chain graduate into on-chain liquidity pools before a conventional asset-specific oracle exists. Our price source is the token's own pool; WETH is the internal pool asset, while players enter and exit in ETH. During an earlier one-day scan, we found 496 new v3 pools, 292 paired with WETH; only 5 of those 292 met the scan's 50 WETH depth threshold. The current testnet parameters imply a 25 WETH gate; coverage at this lower threshold has not been remeasured. We use v3 pools because the oracle reads their observations directly; v4-only tokens need a different price source.

## What exists today?

**On Robinhood Chain testnet, chain ID 46630:** `PoolRounds` at `0x1e928adc9de612b08f78824417d4f5ef354c66d7` and redeemable [TestWETH](https://explorer.testnet.chain.robinhood.com/address/0x702431c8ef4e21fc4180c8395a4b0f3464b7d5a3) are deployed and source-verified. Three test pools for MOONCAT, PEPE, and FROGGO are listed. Their tokens and pools are **stand-ins**: there is no canonical Uniswap v3 deployment for this demo testnet, and the price is moved by a script. They reproduce the pool observations and liquidity-history calls that the round contract uses. Their artificial prices are never presented as organic market prices or user demand.

On the **current contract** (60-second strike window, 0.01 ETH bank) the keeper fixed strikes and settled in an end-to-end testnet run on 2 October. The run checked a winning round, a tie, a round with one side only (refunded in full at the close), claims, fees and referral payments: **40 checks, zero failures**. The keeper fixed the strike 7-9 seconds after the strike window and settled 4-6 seconds after settleAt, against an allowance of 839 seconds. The winning 0.005 stake received 0.0098 WETH (1.96x); a 0.005 stake on a tie received 0.00495. Transaction hashes and timing are in [`measurements/rounds/e2e-testnet-60s.log`](measurements/rounds/e2e-testnet-60s.log). The ETH-in/ETH-out path passed Foundry tests, and TestWETH passed a live deposit and withdrawal; the end-to-end run wrapped the players' ETH through it. A browser-wallet wager on the public site also went through on the current contract: a 0.005 ETH UP bet on FROGGO from MetaMask, settled as a tie (the test pool's price did not move) and collected as 0.00495 ETH.

On **1 October**, we separately ran the current PoolRounds code on a local fork of Robinhood Chain mainnet at block **77,215,106**. The canonical RMHT/WETH pool had about **93.5 WETH** depth against a **50 WETH** gate and **1,801** price observations against a **900** requirement. PoolRounds listed it, read its real v3 price history, settled a local tie and paid **0.0099 WETH** back to each simulated 0.01 WETH trader. [Test, raw output and limits](measurements/rounds/mainnet-fork-2026-10-01.md). All balances, bets and clock changes existed only in the fork; **there was no mainnet deployment or transaction**.

In a second fork test, a local 0.1 WETH swap through that canonical pool changed its price after the strike. PoolRounds read the pool's observations, settled **UP**, and paid **0.0196 WETH** to the simulated 0.01 WETH UP trader. This tests the winner path against real pool code and liquidity; the price-moving swap was made inside the fork, **not by an organic mainnet trader**. [Captured result](measurements/rounds/mainnet-fork-swap-2026-10-01.log).

The [public browser rounds screen](https://rhc.flipthememe.com/rounds) has a desktop layout and Robinhood Chain colors. It shows both sides' totals, optional timing and detailed rules, pool depth, the maximum bank, predicted accepted stake and payout, and the refund fee. The public-browser ETH path was verified on 2 October: [0.005 ETH UP stake](https://explorer.testnet.chain.robinhood.com/tx/0x9764763bf13585ed072aff0e3ddeea315b4c8a59a642791eb857ec7c05cdd029), [tie settlement](https://explorer.testnet.chain.robinhood.com/tx/0xf97856ce5f40eb0387d4b7e56e89bec7f1e39319ddf97699c1d8539431b97a75), and [0.00495 ETH collection](https://explorer.testnet.chain.robinhood.com/tx/0x68686c9d7aab92f6fdcc35af1cdb9ce3382bdf8b546da72f4376968e90982ae4). On 3 October the site showed all three pools and keeper health was `ok`, caught up, with no warnings. No continuous test-price mover is running, so unchanged test-pool prices produce ties. The `/rounds` route is the entry for this submission.

## What is innovative?

The price rule and market capacity are tied to the same on-chain pool. A pool whose observation ring lacks sufficient history cannot safely serve a round. The contract requires depth and observation capacity at listing, uses a time window after betting closes so all players know the same future strike rule, and bounds the accepted bank by pool depth. The 1:1 matched bank makes an active round's promised payouts fit within the traders' stakes, without requiring house liquidity. This **does not** make pool manipulation impossible: the depth rule caps the payoff, and thin pools remain unsuitable.

## Who is it for, and what have you learned about demand?

The intended user already likes Polymarket-style outcome betting and wants a fast wager on a specific Robinhood Chain meme coin that general prediction markets do not list. The first distribution channel to test is that coin's community, with a direct link to its round and visible, verifiable outcomes. We have **no demonstrated organic user demand yet**. Development scripts and founder testing account for the visible testnet activity. The next milestone is to observe whether real participants understand the strike timing, return for another round, and provide enough opposing flow to activate rounds without synthetic stakes.

## Safety and limitations

The contracts have **not received an external security audit**. Each stake is capped at 0.04 ETH on testnet, but multiple wallets can participate, and the cap is not an economic guarantee. An active round on a manipulated or unpriceable pool can end in a 1% refund rather than a directional result. A round that never gets enough opposing flow returns stakes in full and pays nobody. The oracle uses one pool; its checks are not independent price sources. The public demo's scripted stand-in pools do not prove that the same economics will hold with real mainnet liquidity or organic demand. We will not claim a mainnet product is live.

## What we built during the buildathon

We built PoolRounds with a 1:1 matched bank, a future strike, pool-depth limits, oracle failure refunds and player collection. The current testnet version adds direct ETH staking and ETH collection. We deployed and source-verified it, connected a keeper, published the browser interface, and checked the new ETH path in Foundry plus a live WETH deposit/withdraw. The current version completed a testnet end-to-end run with the deployed keeper (40 checks, zero failures); tie and winner settlement were also checked against a real pool on a local mainnet fork. A browser wager on the public site has been placed, settled and collected on the current contract. The remaining submission work is the final video upload.

## Team

Sofia — solo founder, product and engineering, with AI-assisted development and review. State any additional team members or contributors in the actual form if applicable.

## Links for the form

- Public demo: [rhc.flipthememe.com/rounds](https://rhc.flipthememe.com/rounds), live and checked with three pools on 2 October.
- Verified current contract: [PoolRounds on the Robinhood Chain testnet explorer](https://explorer.testnet.chain.robinhood.com/address/0x1e928adc9de612b08f78824417d4f5ef354c66d7).
- Health status: [rounds keeper](https://api-rhc.flipthememe.com/api/rounds/health).
- Repository: `https://github.com/Sofiia7/memepred/tree/robinhood-chain` after Sofia opens it before submission. Point judges to the branch's root `README.md`.
- Video: insert the final recording URL here after verifying it opens without the creator account.

## Demo video, about 3–4 minutes

Recording plan and verified transaction links: [`ROUNDS-DEMO-RUNBOOK.md`](ROUNDS-DEMO-RUNBOOK.md).

1. State the problem plainly: outcome bettors want a quick UP/DOWN market on the Robinhood Chain meme coin they follow. Show the testnet label, three round pools, visible UP/DOWN totals and depth limit. Say that the demo pools have scripted prices and activity is test traffic.
2. Open a round. Show the 5-minute betting window, pause, strike average and exit. Explain that the bet is on strike-to-exit, not on today's displayed spot price; show accepted stake, 1.96× payout and both refund cases.
3. Use a prepared wallet and a prepared round to show the placed bet and a completed round, then Collect. Show the actual transaction in the explorer. Edit across the waiting interval and make the edit visible; the current result is due 16 minutes after the round opens, 11 minutes after betting closes.
4. Show the verified contract, `/api/rounds/health` and the real-pool fork check. Explain why matching equal stakes makes payouts funded by players. End with the actual risks and the next experiment with organic users.

## Submit checklist

- [x] Public `/rounds`, Terms and How it works describe the separate contracts and fees.
- [x] Browser-wallet path on the public site: test ETH, bet, result, Collect as ETH (FROGGO UP 0.005, tie, 0.00495 ETH collected, 2 October).
- [x] Submission code pushed to `robinhood-chain`; CI passed on 3 October.
- [ ] Repository opened by Sofia and source reachable by judges without signing in.
- [ ] Video uploaded and accessible in a signed-out browser; transaction and demo links checked.
- [ ] HackQuest project created, text pasted, track and links checked, submission completed before deadline.
