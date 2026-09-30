# FlipTheMeme — Arbitrum Open House Singapore application

Draft updated 2026-09-30 for the deployed **PoolRounds** testnet product. The public rounds release is live; the fresh-wallet browser check and video remain. Copy the English sections into the HackQuest project form, adapting to its actual fields. Check every link and the video before submission. This document does not record a HackQuest submission.

The [published buildathon page](https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon) accepts an existing project deployed on an Arbitrum chain; Robinhood Chain is named as an example, and Arbitrum Sepolia establishes that testnet deployment can qualify. The page does not explicitly confirm whether **Robinhood Chain testnet** receives the Robinhood-reserved prize. Submission closes **4 October 2026, 23:59 Singapore time** (17:59 Budapest). Registration was completed 11 September. The proposed track is **Promising Products**.

## Project name

FlipTheMeme

## One-liner

Short, transparent UP/DOWN rounds on Robinhood Chain memecoins. Traders stake test WETH on opposite sides; accepted stakes are matched one for one and settled from each token pool's on-chain time-weighted price.

## What problem does it solve?

Communities following newly graduated memecoins can take a bounded view on the next price move without buying the token itself. New tokens usually have no listed price feed. An ordinary spot quote can be manipulated at the instant of settlement, and an LP that fills every one-sided bet absorbs adverse selection. Our product uses the token's own v3 pool for a published price rule and accepts only equally backed UP and DOWN stakes. Users can see both sides' totals before betting. The size of an active round is constrained by the depth of its pool.

## How does the current product work?

Each 5-minute round accepts public UP and DOWN stakes of 0.005–0.04 test WETH per wallet. Only the smaller side's total plays on each side, with larger-side excess refundable without a fee. A matched bank below 0.02 WETH does not activate; every stake in that round is refundable in full. A pool must clear the contract's depth and observation gates, and the bank cannot exceed pool depth divided by 2,500. The demo has three listed tokens.

After betting closes, a 5-minute pause starts. The strike is averaged over the following 5 minutes; the exit is measured 5 minutes after the strike window ends. The result is due about 20 minutes after the round opened. A trader is betting on the move **from the future strike to the exit**, not on the displayed price at entry. A winner receives 1.96× the accepted portion of their stake, plus any unmatched portion. The contract retains 2% of the matched bank when it produces a winner. A tie or an active round that cannot be priced returns the matched stakes minus 1%. Players press **Collect** to receive winnings or refunds; gas is separate.

The round contract reads both price windows from the token pool's on-chain observations. Anyone can verify the result, call settlement when due, and collect their own position. A keeper normally fixes the strike and settles within contract-reported deadlines. Public health checks and an external watchdog monitor that path.

## Why Robinhood Chain?

Launchpad tokens on Robinhood Chain graduate into on-chain liquidity pools before a conventional asset-specific oracle exists. Our price source is the token's own pool, and the stake token is WETH on that chain. During an earlier one-day scan, we found 496 new v3 pools, 292 paired with WETH; only 5 of those 292 met the current round depth gate of 50 WETH. That is a measured coverage limitation, not a claim that every memecoin is eligible. We use v3 pools because the oracle reads their observations directly; v4-only tokens need a different price source.

## What exists today?

**On Robinhood Chain testnet, chain ID 46630:** `PoolRounds` at `0xe3620f0855c4dc1aace648cc8240a4fa89fd93c4` and its `ReferralRegistry` are deployed and source-verified. Three test pools for MOONCAT, PEPE, and FROGGO are listed. Their tokens and pools are **stand-ins**: there is no canonical Uniswap v3 deployment for this demo testnet, and the price is moved by a script. They reproduce the pool observations and liquidity-history calls that the round contract uses. Their artificial prices are never presented as organic market prices or user demand.

The deployed keeper on the server settled and fixed strikes in an end-to-end testnet run. That run checked a winning round, a tie, a round with one side only, claims, fees and referral payments: **40 checks, zero failures**. The winning 0.02 WETH stake received 0.0392 WETH; a 0.01 WETH stake on a tie received 0.0099 WETH. Transaction hashes and observed timing are in [`measurements/rounds/e2e-testnet.log`](measurements/rounds/e2e-testnet.log). `/api/rounds/health` reports the current keeper state. Contract tests cover monetary invariants, fuzzing, deadline boundaries and oracle failure paths. The full Foundry suite had **646 passing tests on 30 September**; mainnet fork tests need `RHC_MAINNET_RPC`, so an offline green run by itself is not evidence those tests ran against live pools.

The [public browser rounds screen](https://rhc.flipthememe.com/rounds) shows both sides' totals, a timeline from bets to exit, pool depth, the maximum bank, predicted accepted stake and payout, the refund fee and explicit acknowledgement before betting. It was checked publicly with three pools on 30 September. A fresh-wallet public-browser transaction and demo video remain the final acceptance check. The continuous orderbook markets are an **older, separate mode** that remains in the same app; they use a different contract, a per-match clock, optional LP fills and different fees. The figures and rules above belong to PoolRounds.

## What is innovative?

The price rule and market capacity are tied to the same on-chain pool. A pool whose observation ring lacks sufficient history cannot safely serve a round. The contract requires depth and observation capacity at listing, uses a time window after betting closes to reduce the stale-entry advantage, and bounds the accepted bank by pool depth. The 1:1 matched-bank model does not require a house vault to take a side, so an active round's promised payouts fit inside what the traders deposited. This does **not** make pool manipulation impossible: the depth rule caps the payoff, and thin pools remain unsuitable.

Before this design, we built continuous PvP orderbook markets with an optional LP vault. A 47-hour test of a **previous deployment** exercised 1,113 scripted orders and 278 matches. It measured settlement and monitoring reliability; those orders were generated by our own test scripts, **not real user traction**. Analysis of that design exposed an edge against the vault from stale entry TWAP, leading us to build the matched-bank rounds as the current candidate. This is the buildathon's substantive product change.

## Who is it for, and what have you learned about demand?

The intended user is someone already following a specific liquid memecoin who wants a short, clearly capped directional position instead of owning it. The first distribution channel to test is that token's community, with a direct link to its pool's round and visible, verifiable outcomes. We have **no demonstrated organic user demand yet**. Volume and bets visible on the testnet were generated by development scripts and should be read as reliability tests. The next milestone is to observe whether real participants understand the strike timing, return for another round, and provide enough opposing flow to activate rounds without synthetic stakes.

## Safety and limitations

The contracts have **not received an external security audit**. Each stake is capped at 0.04 WETH on testnet, but multiple wallets can participate, and the cap is not an economic guarantee. An active round on a manipulated or unpriceable pool can end in a 1% refund rather than a directional result. A round that never gets enough opposing flow returns stakes in full and pays nobody. The oracle uses one pool; its checks are not independent price sources. The public demo's scripted stand-in pools do not prove that the same economics will hold with real mainnet liquidity or organic demand. We will not claim a mainnet product is live.

## What we built during the buildathon

We adapted the existing engine to Robinhood Chain testnet, deployed and source-verified the first stack, ran a 47-hour scripted soak on an earlier deployment, measured the oracle and settlement gas, identified the vault's adverse-selection edge, designed and implemented PoolRounds with a 1:1 bank and post-close strike, deployed that contract and its keeper, completed a testnet end-to-end run, and published the browser interface. The continuous markets are retained separately for comparison. The remaining submission work is a fresh-wallet browser check and video.

## Team

Sofia — solo founder, product and engineering, with AI-assisted development and review. State any additional team members or contributors in the actual form if applicable.

## Links for the form

- Public demo: [rhc.flipthememe.com/rounds](https://rhc.flipthememe.com/rounds), live and checked with three pools on 30 September.
- Verified current contract: [PoolRounds on the Robinhood Chain testnet explorer](https://explorer.testnet.chain.robinhood.com/address/0xe3620f0855c4dc1aace648cc8240a4fa89fd93c4).
- Health status: [rounds keeper](https://api-rhc.flipthememe.com/api/rounds/health).
- Repository: `https://github.com/Sofiia7/memepred` after the final branch is pushed and Sofia opens it before submission. Point judges to the `robinhood-chain` branch and `docs/rhc/README.md`.
- Video: insert the final recording URL here after verifying it opens without the creator account.

## Demo video, about 3–4 minutes

Recording plan and verified transaction links: [`ROUNDS-DEMO-RUNBOOK.md`](ROUNDS-DEMO-RUNBOOK.md).

1. State the problem and show the testnet label, three round pools, visible UP/DOWN totals and depth limit. Say that the demo pools have scripted prices and activity is test traffic.
2. Open a round. Show the 5-minute betting window, pause, strike average and exit. Explain that the bet is on strike-to-exit, not on today's displayed spot price; show accepted stake, 1.96× payout and both refund cases.
3. Use a prepared wallet and a prepared round to show the placed bet and a completed round, then Collect. Show the actual transaction in the explorer. Edit across the waiting interval and make the edit visible; do not imply the 20-minute result happened immediately.
4. Show the verified contract, `/api/rounds/health` and a short screen of tests/measurements. End with the actual risks, and the next experiment with organic users.

## Submit checklist

- [x] Public `/rounds`, Terms and How it works describe the separate contracts and fees.
- [ ] Fresh-wallet path on the public site: test ETH, wrap, approve, bet, result, Collect.
- [ ] Final branch pushed; source reachable by judges after Sofia opens the repository.
- [ ] Video uploaded and accessible in a signed-out browser; transaction and demo links checked.
- [ ] HackQuest project created, text pasted, track and links checked, submission completed before deadline.
