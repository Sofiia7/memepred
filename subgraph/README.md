# MemePred Subgraph

Indexes MemePred orderbook markets + LP vault + referrals + badges on Base.

## Setup

```bash
cd subgraph
npm install
```

## Before first deploy

1. Run `forge script Deploy.s.sol` on contracts/, copy deployed addresses.
2. Edit `subgraph.yaml` — replace `address: 0x000...000` and `startBlock: 0` for each `dataSource` with the real addresses and the block in which they were deployed.
3. Generate ABI files into `./abis/`:
   ```bash
   for c in MarketFactory LiquidityPool ReferralRegistry FeeDistributor BadgeNFT GenesisNFT OrderbookMarket; do
     jq '.abi' ../contracts/out/$c.sol/$c.json > abis/$c.json
   done
   ```
4. `npm run codegen && npm run build`.
5. `SUBGRAPH_NAME=org/memepred npm run deploy:base`.

## Schema highlights

- `Market` / `Order` / `Match` — orderbook lifecycle (PvP and LP-matched).
- `Trader` — bets, P&L, streaks, badges.
- `LPVault` / `LPProvider` / `LPMatchActivity` — ERC4626 LP state.
- `FeeFlow` / `ReferralEarning` — fee distribution audit trail.
- `ProtocolStats` — global aggregates (singleton id="global").

## Useful queries

```graphql
# Top 10 markets by volume
{ markets(orderBy: totalVolume, orderDirection: desc, first: 10) {
    id feedId totalOrders totalMatches totalVolume } }

# Trader leaderboard by profit
{ traders(orderBy: totalProfit, orderDirection: desc, first: 50) {
    id totalProfit wonOrders maxStreak } }

# LP positions
{ lpProviders(orderBy: shares, orderDirection: desc) {
    id shares isGenesis totalFeesClaimed } }
```
