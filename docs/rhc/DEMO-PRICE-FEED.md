# Continuous testnet demo prices — 4 October 2026

The public rounds use **ContinuousDemoPool**, an immutable deterministic demo oracle. It is a stand-in, not a traded Uniswap pool. The interface labels the graphs **TESTNET DEMO FEED · simulated pool prices**. There is no hourly stop, updater wallet, or recurring price-push transaction.

Each pool has a fixed 256-step price schedule with a new step every 20 seconds. Spot and cumulative prices use the same schedule; its cumulative sum is computed in constant time from fixed-size data. Time passing does not grow storage or wager/settlement gas. The schedule repeats and is predictable: it demonstrates functionality, not genuine market price discovery. Historical values are reconstructed from this simulated schedule, not historical trades.

| Demo coin | Current verified pool |
|---|---|
| FROGGO | [0x9935aef7659f1c30843f0c959c349304f1bccfbe](https://explorer.testnet.chain.robinhood.com/address/0x9935aef7659f1c30843f0c959c349304f1bccfbe) |
| MOONCAT | [0x0cc364d14046c3096ac247a7cc8bbb092024d186](https://explorer.testnet.chain.robinhood.com/address/0x0cc364d14046c3096ac247a7cc8bbb092024d186) |
| PEPE | [0xc6dea87acb96a968cac414ebf9d98fc9092478d9](https://explorer.testnet.chain.robinhood.com/address/0xc6dea87acb96a968cac414ebf9d98fc9092478d9) |

All three are source-verified, registered on the existing stand-in factory at fee tier 3000, and listed on the **same** PoolRounds contract `0x1e928adc9de612b08f78824417d4f5ef354c66d7`. PoolRounds, TestWETH, the ETH entry/exit path and round parameters did not change. Retired fee-10000 pools no longer accept new bets; their open rounds, settlements and claims remain available. The previous factory fee-tier entries were not overwritten.

The constructor accepts only testnet 46630 or local test chain 31337. Declared liquidity is synthetic too. This feed is unsuitable for real-money markets; mainnet-fork evidence uses an actual canonical pool instead.

## Server supervision

`backend/scripts/rhc-continuous-demo-watch.mjs` runs as the separate `rhc-demo-watch` service with `restart: unless-stopped`, a Docker health check, bounded logs and no keys. It reads all three pools every 20 seconds and checks that prices move and oracle history is readable. Its loopback-only health endpoint is `http://127.0.0.1:3003`. Restart recovery was checked on 4 October. Prices themselves continue changing even if this supervisor stops; the RPC and deployed oracle are their source.

Compose file: `deploy/docker-compose.rhc-demo.yml`. It uses the existing RHC Node runtime and mounts public code/config only. From `/home/openclaw/memepred/deploy`:

```bash
docker compose -f docker-compose.yml -f docker-compose.rhc.yml -f docker-compose.rhc-demo.yml up -d rhc-demo-watch
curl http://127.0.0.1:3003
docker logs --tail 10 deploy-rhc-demo-watch-1
```

Deployment helper: `scripts/rhc/continuous-demo-deploy.mts` (tsx). Its default invocation is read-only; `--deploy` deploys/registers, and `--activate` lists all new pools before retiring new betting on the old ones. Source deployment commit: `ef75a3c`. Receipt/config record: `measurements/continuous-demo/deployment-2026-10-04.json`.

Nine relevant Foundry tests passed, including 1,000 random interval-integral checks, cycle-boundary accuracy, a full native-ETH round, claims after delisting, mainnet rejection and a ten-year gas comparison. The public screen showed three moving graphs, and keeper health returned `ok`, three listed pools, caught up and no warnings.

The earlier bounded price writer was stopped after activation. It remains historical tooling, not the current demo feed.
