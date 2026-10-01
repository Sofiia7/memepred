# PoolRounds on a real Robinhood Chain pool: local fork check

First run on 1 October 2026 against public Robinhood Chain mainnet RPC, chain ID **4663**, at block **77,215,106**. The first result is in [`mainnet-fork-2026-10-01.log`](mainnet-fork-2026-10-01.log). A second run added a fork-only swap and is in [`mainnet-fork-swap-2026-10-01.log`](mainnet-fork-swap-2026-10-01.log) (the local cache warning was omitted). Both use [`contracts/test/PoolRoundsMainnetFork.t.sol`](../../../../contracts/test/PoolRoundsMainnetFork.t.sol). **No mainnet transaction was sent.** Foundry copied mainnet state into a local fork; deployment, token balances, stakes, swap, clock changes and collections existed only there.

```bash
cd contracts
RHC_MAINNET_RPC=https://robinhood-rpc.publicnode.com forge test --match-path test/PoolRoundsMainnetFork.t.sol -vv
```

| Observed fact | Result |
|---|---:|
| Canonical v3 [RMHT/WETH pool](https://robinhoodchain.blockscout.com/address/0xabe3B1fF5Fc6a9638D0c46f2379B20f7e6173bEe) | `0xabe3B1fF5Fc6a9638D0c46f2379B20f7e6173bEe` |
| WETH depth at the fork head | 93.513564319882490993 WETH |
| PoolRounds listing depth gate | 50 WETH |
| Observation cardinality / required | 1,801 / 900 |
| Real-pool strike and exit tick read by PoolRounds | 153,999 / 153,999 |
| Result of two simulated 0.01 WETH bets | TIE; 0.0099 WETH collected by each trader |
| Foundry result | 1 passed, 0 failed, 0 skipped |

The second run used block **77,406,312** and the same canonical RMHT/WETH pool. It first reproduced the tie. In a separate test, two simulated traders staked 0.01 WETH each; after the strike was fixed, a **locally simulated 0.1 WETH buy** called the real pool's `swap()` implementation against its forked liquidity. The pool's tick moved from **153,999** at strike to **153,978** for the exit window. PoolRounds settled **UP** and the UP trader collected **0.0196 WETH**; the DOWN trader collected zero. Both tests passed. The simulated buy is an input to the test, not observed organic trading and not a Robinhood Chain transaction.

This checks the **current PoolRounds code**. It covers canonical-pool and depth/history gates, real Uniswap v3 `observe()` data, the strike and exit reads, active-round settlement, fee accounting and claims. Advancing the fork's clock alone produces a tie; the second test additionally exercises a winner through the real pool's swap and observation code. The separate [testnet end-to-end run](e2e-testnet.log) covers a winning outcome with an explicit price step and the deployed keeper.

This does **not** prove that an active Robinhood mainnet round would have the same liquidity over twenty real minutes, that memecoin price manipulation is unprofitable, that the browser-wallet path works, or that users want the product. The test uses a live fork head; we have not verified that the public endpoint supports a permanently pinned historical replay. A future run can fail if RMHT loses depth, history or canonical status; that would be a meaningful change in eligibility. Without `RHC_MAINNET_RPC`, Foundry reports these tests as skipped.
