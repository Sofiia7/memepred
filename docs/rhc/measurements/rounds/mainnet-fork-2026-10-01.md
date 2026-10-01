# PoolRounds on a real Robinhood Chain pool: local fork check

Run on 1 October 2026 against public Robinhood Chain mainnet RPC, chain ID **4663**, at block **77,215,106**. The command and raw result are in [`mainnet-fork-2026-10-01.log`](mainnet-fork-2026-10-01.log); the test is [`contracts/test/PoolRoundsMainnetFork.t.sol`](../../../../contracts/test/PoolRoundsMainnetFork.t.sol). **No mainnet transaction was sent.** Foundry copied mainnet state into a local fork; deployment, token balances, stakes, clock changes and collections existed only there.

```bash
cd contracts
RHC_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/PoolRoundsMainnetFork.t.sol -vv
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

This checks the **current PoolRounds code**, not only the older continuous-market resolver. It covers canonical-pool and depth/history gates, real Uniswap v3 `observe()` data, the strike and exit reads, active-round settlement, fee accounting and claims. The fork's pool price does not change when Foundry advances its local clock, so this run proves a tie path. The separate [testnet end-to-end run](e2e-testnet.log) covers a winning outcome with an explicit price step and the deployed keeper.

This does **not** prove that an active Robinhood mainnet round would have the same liquidity over twenty real minutes, that memecoin price manipulation is unprofitable, that the browser-wallet path works, or that users want the product. The test uses a live fork head because the public RPC does not retain enough state for a permanently pinned historical replay. A future run can fail if RMHT loses depth, history or canonical status; that would be a meaningful change in eligibility. Without `RHC_MAINNET_RPC`, Foundry reports this test as skipped.
