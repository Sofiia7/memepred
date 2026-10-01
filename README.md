# FlipTheMeme — short UP/DOWN rounds for Robinhood Chain meme coins

FlipTheMeme is for people who enjoy betting on outcomes but cannot find a short market for the specific meme coin they follow. They pick UP or DOWN without buying the coin. The current product is a **Robinhood Chain testnet prototype** using test WETH.

[Try the public rounds demo](https://rhc.flipthememe.com/rounds) · [Verified PoolRounds contract](https://explorer.testnet.chain.robinhood.com/address/0xe3620f0855c4dc1aace648cc8240a4fa89fd93c4) · [Buildathon application text](docs/rhc/buildathon-application.md) · [Demo recording plan](docs/rhc/ROUNDS-DEMO-RUNBOOK.md)

The hackathon product is **PoolRounds**. The older continuous Markets tab is a separate contract with different timing and fees.

## One round in 30 seconds

1. Traders stake 0.005–0.04 test WETH on UP or DOWN during a five-minute betting window. The contract accepts equal amounts on both sides. Unmatched stake is returned without a fee; a round without enough opposing stake does not activate and refunds everyone in full.
2. After betting closes there is a five-minute pause. The strike is averaged over the next five minutes from the coin's v3 pool, then compared with an exit price five minutes later. The bet is on the move **from that future strike**, not the displayed price when the trader clicks.
3. A winner collects 1.96× the accepted stake. The contract keeps 2% of the matched bank on a win. A tie or an unpriceable active round returns matched stakes minus 1%. Players call **Collect**; payouts are not pushed automatically.

The pool must pass depth and price-history checks. The accepted bank is also limited by the pool's WETH depth. These checks reduce the amount exposed to price manipulation; they cannot make a thin coin safe.

## Why we changed the design

The earlier continuous-market system was exercised for 47 hours with **1,113 scripted orders and 278 matches**. This established operational behavior, not user demand. We then replayed **743,127 real swaps across 15 Robinhood Chain pools** and found that a simulated fast trader could win **89.4%** of decided 60-second matches against the old LP vault after a swap. The strike included pre-swap prices, giving that trader an edge. [Backtest and method](docs/rhc/SHARP-EDGE.md).

PoolRounds removes the house LP from each bet: only matched trader stakes play, with a published 1:1 cap and a strike measured after betting closes. That removes the vault's exposure to the measured edge. Skilled traders can still win against other traders, and manipulation of the underlying pool remains possible.

## Evidence and limits

| Check | What it establishes |
|---|---|
| [Testnet end-to-end run](docs/rhc/measurements/rounds/e2e-testnet.log) | Deployed keeper, win, tie, inactive refund, claims, fees and referrals: 40 checks, zero failures. These are development-script transactions. |
| [Real-pool mainnet fork](docs/rhc/measurements/rounds/mainnet-fork-2026-10-01.md) | On Robinhood Chain mainnet state at block **77,215,106**, the current PoolRounds code listed the canonical RMHT v3 pool, read its real observations, settled a fork-only tie and paid both simulated traders. |
| [Foundry suite](docs/rhc/measurements/rounds/README.md) | Monetary invariants, adversarial oracle paths, fuzzing and deadline boundaries. The full suite had 646 passing tests on 30 September; the new live fork test runs only when `RHC_MAINNET_RPC` is set. |

The three public testnet pools are **stand-ins with scripted prices** because the demo testnet lacks a canonical Uniswap v3 deployment. Their prices and transactions do not show organic user demand. The contract has **no external security audit**. The mainnet fork uses real pool state but local balances and clock changes; it is not a mainnet deployment or a live wager. A fresh-wallet browser transaction and video are still to be completed. No claim of real user traction is made.

To reproduce the real-pool check from `contracts/` with Foundry installed:

```bash
RHC_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/PoolRoundsMainnetFork.t.sol -vv
```

This reads a live pool, so its eligibility can change. Without the environment variable the test is explicitly skipped. The public RPC keeps little historical state; use the [recorded result and block](docs/rhc/measurements/rounds/mainnet-fork-2026-10-01.md) when reviewing the 1 October run.

The [Robinhood Chain project notes](docs/rhc/README.md) explain architecture, deployment, measurements and remaining work. The current product code is under `contracts/src/PoolRounds.sol`, `backend/src/rounds/` and `frontend/src/rounds/`.
