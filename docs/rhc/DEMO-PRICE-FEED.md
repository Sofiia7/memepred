# Bounded testnet demo price feed — 4 October 2026

The public rounds pools are `PoolRoundMockPool` stand-ins, not live traded markets. For the live screen recording, `scripts/rhc/rounds-price-mover.mjs` appends simulated price changes on Robinhood Chain testnet 46630. The interface labels the charts **TESTNET DEMO FEED · simulated pool prices**. Both the chart and PoolRounds read these same on-chain prices; no decorative frontend prices or past history are generated.

The feed started at 12:35 UTC on 4 October on the VPS, as a separate Node process inside `deploy-rhc-keeper-1`. It uses a dedicated throwaway test wallet, separate from the settlement keeper, funded with 0.0005 test ETH for gas. The server keeper retains over 0.01 test ETH. This is test traffic, not organic market activity.

- Approximately one update per pool every 70–75 seconds (60 seconds of sleep plus reads and receipts).
- Maximum 180 successful pushes in total and 64 stored segments per pool. The process stops automatically; do not restart it indefinitely. The mock scans its accumulated history during oracle reads, so unbounded updates would increase wager and settlement gas.
- No retroactive timestamps, forced winning side, fabricated bets, or alterations to existing settlements.
- The current pools remain FROGGO `0xa8b93b1c1e89ad2f1fe127efd37cc30e28d8f7b4`, MOONCAT `0x923a9486cd5cfa7a2929af09ee3082c9b411c37c`, and PEPE `0x5daf9bbd4a52d90a963e5f4e9a9c7df56673d25c`.

First FROGGO update: [tick 0 → −21](https://explorer.testnet.chain.robinhood.com/tx/0x83b8093121f5ffcc399924b859d15deefe09d06c243ab75af588134c55e171df). A subsequent update moved it to −35, and the public chart showed +0.35% in coin/WETH orientation. Movement is not a guarantee against ties: a round still compares its own measured strike and exit prices.

The frontend loads recent 20-second oracle averages using `observe()` and continues with five-second spot reads. Refreshing the page preserves visible recent history by reading it again from chain. The countdown no longer pulses; the final minute uses a steady amber color.

The mover reads a gitignored `.env.rounds-mover` beside the script. Keep the wallet key out of Git and logs. Read-only preflight: `node scripts/rhc/rounds-price-mover.mjs`. Running requires `--yes-testnet` and a separately funded `RHC_MOVER_PRIVATE_KEY`. Server log: `/tmp/rounds-demo-feed.log` inside the keeper container. Restarting the keeper container stops this temporary feed; it does not restart automatically.
