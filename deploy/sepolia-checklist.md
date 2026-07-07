# Sepolia Soak — Sprint 5 checklist

Run order. Don't skip steps; the verification ones are the point.

## 0. Prereqs

- [ ] `.env` filled: `PRIVATE_KEY` (deployer, **one-shot**), `MULTISIG_ADDRESS` (Gnosis Safe 3/5 on Sepolia), `KEEPER_ADDRESS`, `KEEPER_PRIVATE_KEY`, `TREASURY_ADDRESS`, `LP_FEE_SINK_ADDRESS`, `NFT_REWARDS_ADDRESS`, `BADGE_MINTER_ADDRESS`, `USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `PYTH_ADDRESS=0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`.
- [ ] Multisig 3/5 deployed on Sepolia (Safe app at app.safe.global, base-sepolia network).
- [ ] Deployer wallet has ≥ 0.1 ETH on Sepolia.

## 1. Deploy contracts (one-shot)

```bash
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

Console prints `MARKET_FACTORY=…` etc. Copy into `.env`. Deploy script also
hands ownership over to multisig and revokes deployer admin in one tx —
do NOT re-run.

## 2. Verify ownership handoff

```bash
forge script contracts/script/VerifyRoles.s.sol \
  --rpc-url https://sepolia.base.org \
  --sig "run(address,address,address,address,address,address,address,address,address)" \
  $MULTISIG_ADDRESS $DEPLOYER_ADDRESS \
  $FEE_DISTRIBUTOR $REFERRAL_REGISTRY $ORACLE_RESOLVER \
  $GENESIS_NFT $LIQUIDITY_POOL $MARKET_FACTORY $BADGE_NFT
```

Expected output ends with: `VerifyRoles: ALL GREEN`. If anything is red,
**STOP** — investigate before continuing.

## 3. Fund OracleResolver with ETH

The resolver pays Pyth update fees from its own balance.

```bash
cast send $ORACLE_RESOLVER --value 0.1ether --rpc-url https://sepolia.base.org \
  --private-key $KEEPER_PRIVATE_KEY
```

Confirm via `/api/keeper/health` (after keeper boot): `resolverEthAlert: ok`.

## 4. Subgraph — deploy to Sepolia studio

```bash
cd subgraph
npx graph build
npx graph deploy --studio flipthememe-sepolia
```

Copy the deployed query URL into frontend `.env` as `VITE_GRAPH_URL`.

## 5. Backend + keeper boot

```bash
cd deploy
docker compose up -d --build
```

Verify:
- [ ] `curl https://api.flipthememe.com/health` → 200
- [ ] `curl https://api.flipthememe.com/api/keeper/health` → 200 within 5 min
- [ ] Postgres has the 002 + 003 migrations applied: `\dt` shows
      `orders, matches, order_matches, _ingested_logs, invariant_snapshots`

## 6. First market created

Keeper's `marketCreator` should auto-spawn 5×2 markets within 5 min of
boot (5 durations × 2 feeds = PEPE, DOGE). Verify:

```bash
psql -c "SELECT market_address, feed_symbol, duration_secs, close_time FROM markets ORDER BY close_time;"
```

If empty after 10 min: check keeper logs for `marketCreator` errors.

## 7. Cloudflare Worker

```bash
cd workers
npx wrangler secret put WORKER_SECRET   # paste shared secret
npx wrangler secret put ORIGIN_URL      # https://api-origin.flipthememe.com
npx wrangler deploy
```

Verify:
- [ ] `curl -H "CF-IPCountry: US" https://api.flipthememe.com/api/geo` → 451
- [ ] `curl https://api.flipthememe.com/api/geo/config` → `{"blocked":["US",...]}`

## 8. Tenderly alerts

```bash
# Import deploy/tenderly-alerts.yaml via Tenderly dashboard:
#   Project → Alerts → Import → YAML
# Replace ${MARKET_FACTORY} etc. with real addresses first.
```

Verify by manually triggering one (e.g. pause a test market) — Discord
should ping within 60 s.

## 9. Bot soak — 48 hours

```bash
export USDC_FAUCET_KEY=0x...        # wallet holding 5000 testnet USDC
export BOT_MNEMONIC="..."           # 12/24-word seed → derives 50 bot keys

tsx scripts/bot-harness.ts --bots 50 --duration 48h --tick 30s
```

Tail metrics:

```bash
tail -f logs/soak-*.jsonl | jq 'select(.event == "metrics")'
```

## 10. Post-soak: invariant report

```sql
-- max drift across the run
SELECT MAX(drift_usdc), MAX(alert_level)
FROM invariant_snapshots
WHERE snapshot_at >= '<soak_start>';

-- any critical?
SELECT * FROM invariant_snapshots WHERE alert_level = 'critical';
```

Expected: zero critical rows. drift_usdc max ≤ $1 (rounding / indexer lag).

## 11. CEF application (parallel — see docs/sprint5/cef-application.md)

While soak is running:
- [ ] Mini app at `https://flipthememe.com` reachable from Warpcast preview tool
- [ ] First cast about prelaunch posted, tagging @gmfarcaster @rish @dish
- [ ] Application form submitted with: Sepolia addresses, demo URL, this checklist as evidence
