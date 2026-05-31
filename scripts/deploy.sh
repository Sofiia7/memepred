#!/usr/bin/env bash
# End-to-end deployment for MemePred.
#
#   ./scripts/deploy.sh sepolia          # → Base Sepolia (84532)
#   ./scripts/deploy.sh mainnet          # → Base Mainnet (8453)  ← run twice: dry-run first
#   ./scripts/deploy.sh sepolia --skip-subgraph
#
# Reads required env from ./scripts/.env.deploy (gitignored). Template:
#
#   PRIVATE_KEY=0x...                # deployer key (one-shot)
#   MULTISIG_ADDRESS=0x...
#   TREASURY_ADDRESS=0x...
#   LP_FEE_SINK_ADDRESS=0x...
#   NFT_REWARDS_ADDRESS=0x...
#   KEEPER_ADDRESS=0x...
#   BADGE_MINTER_ADDRESS=0x...
#   BASE_RPC_URL=https://...
#   BASESCAN_API_KEY=...
#   SUBGRAPH_NAME=org/memepred       # optional

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${1:-sepolia}"; shift || true
SKIP_SUBGRAPH="false"
for a in "$@"; do
  case "$a" in
    --skip-subgraph) SKIP_SUBGRAPH="true" ;;
  esac
done

if [[ -f "$ROOT/scripts/.env.deploy" ]]; then
  set -a; source "$ROOT/scripts/.env.deploy"; set +a
fi

case "$NETWORK" in
  sepolia)
    : "${BASE_RPC_URL:=https://sepolia.base.org}"
    CHAIN_ID=84532
    ;;
  mainnet)
    : "${BASE_RPC_URL:=https://mainnet.base.org}"
    CHAIN_ID=8453
    ;;
  *) echo "unknown network: $NETWORK"; exit 1 ;;
esac

cd "$ROOT/contracts"

echo "▶ forge build + test"
forge test --no-match-coverage 'mocks|test|script|lib' > /dev/null
forge build > /dev/null

echo "▶ deploy contracts to $NETWORK (chainId=$CHAIN_ID)"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  ${BASESCAN_API_KEY:+--verify --etherscan-api-key "$BASESCAN_API_KEY"} \
  -vv | tee /tmp/memepred-deploy.log

# Parse addresses from console.log output.
extract() {
  local key="$1"
  grep -E "^  ${key}=" /tmp/memepred-deploy.log | tail -1 | sed -E "s/.*=//; s/[^0-9a-fA-Fx]//g"
}

FEE_DISTRIBUTOR="$(extract FEE_DISTRIBUTOR)"
REFERRAL_REGISTRY="$(extract REFERRAL_REGISTRY)"
ORACLE_RESOLVER="$(extract ORACLE_RESOLVER)"
GENESIS_NFT="$(extract GENESIS_NFT)"
LIQUIDITY_POOL="$(extract LIQUIDITY_POOL)"
MARKET_FACTORY="$(extract MARKET_FACTORY)"
BADGE_NFT="$(extract BADGE_NFT)"

if [[ -z "$MARKET_FACTORY" || -z "$LIQUIDITY_POOL" ]]; then
  echo "❌ failed to parse addresses — inspect /tmp/memepred-deploy.log"
  exit 1
fi

echo "✓ deployed:"
echo "  FEE_DISTRIBUTOR=$FEE_DISTRIBUTOR"
echo "  REFERRAL_REGISTRY=$REFERRAL_REGISTRY"
echo "  ORACLE_RESOLVER=$ORACLE_RESOLVER"
echo "  GENESIS_NFT=$GENESIS_NFT"
echo "  LIQUIDITY_POOL=$LIQUIDITY_POOL"
echo "  MARKET_FACTORY=$MARKET_FACTORY"
echo "  BADGE_NFT=$BADGE_NFT"

# Find deploy block (last block in broadcast file).
BROADCAST_FILE="$(ls -t broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json 2>/dev/null | head -1)"
START_BLOCK="$(jq -r '.receipts[0].blockNumber' "$BROADCAST_FILE" 2>/dev/null | xargs -I{} printf '%d' {})"
echo "  startBlock=$START_BLOCK"

# ──────────────────────────────────────────────────────────────
# Update env files
# ──────────────────────────────────────────────────────────────
echo "▶ updating env files"

write_env() {
  local file="$1"
  cp "$file" "$file.bak" 2>/dev/null || true
  for kv in \
    "FEE_DISTRIBUTOR=$FEE_DISTRIBUTOR" \
    "REFERRAL_REGISTRY=$REFERRAL_REGISTRY" \
    "ORACLE_RESOLVER=$ORACLE_RESOLVER" \
    "GENESIS_NFT=$GENESIS_NFT" \
    "LIQUIDITY_POOL=$LIQUIDITY_POOL" \
    "MARKET_FACTORY=$MARKET_FACTORY" \
    "BADGE_NFT=$BADGE_NFT"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
      sed -i.tmp "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.tmp"
    else
      echo "$kv" >> "$file"
    fi
  done
}

write_env_vite() {
  local file="$1"
  cp "$file" "$file.bak" 2>/dev/null || true
  for kv in \
    "VITE_FEE_DISTRIBUTOR=$FEE_DISTRIBUTOR" \
    "VITE_REFERRAL_REGISTRY=$REFERRAL_REGISTRY" \
    "VITE_ORACLE_RESOLVER=$ORACLE_RESOLVER" \
    "VITE_GENESIS_NFT=$GENESIS_NFT" \
    "VITE_LIQUIDITY_POOL=$LIQUIDITY_POOL" \
    "VITE_MARKET_FACTORY=$MARKET_FACTORY" \
    "VITE_BADGE_NFT=$BADGE_NFT"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
      sed -i.tmp "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.tmp"
    else
      echo "$kv" >> "$file"
    fi
  done
}

# backend & deploy stack pick up the same vars
touch "$ROOT/backend/.env" "$ROOT/deploy/.env" "$ROOT/frontend/.env.production"
write_env       "$ROOT/backend/.env"
write_env       "$ROOT/deploy/.env"
write_env_vite  "$ROOT/frontend/.env.production"

# ──────────────────────────────────────────────────────────────
# Subgraph
# ──────────────────────────────────────────────────────────────
if [[ "$SKIP_SUBGRAPH" != "true" && -n "${SUBGRAPH_NAME:-}" ]]; then
  echo "▶ regenerating subgraph ABIs + manifest"
  cd "$ROOT/subgraph"
  mkdir -p abis
  for c in MarketFactory LiquidityPool ReferralRegistry FeeDistributor BadgeNFT GenesisNFT OrderbookMarket; do
    jq '.abi' "$ROOT/contracts/out/$c.sol/$c.json" > "abis/$c.json"
  done

  # Substitute addresses + startBlock into subgraph.yaml
  sed -E -i.bak \
    -e "s|MARKET_FACTORY_PLACEHOLDER|$MARKET_FACTORY|g" \
    -e "s|LIQUIDITY_POOL_PLACEHOLDER|$LIQUIDITY_POOL|g" \
    -e "s|ORACLE_RESOLVER_PLACEHOLDER|$ORACLE_RESOLVER|g" \
    -e "s|FEE_DISTRIBUTOR_PLACEHOLDER|$FEE_DISTRIBUTOR|g" \
    -e "s|REFERRAL_REGISTRY_PLACEHOLDER|$REFERRAL_REGISTRY|g" \
    -e "s|GENESIS_NFT_PLACEHOLDER|$GENESIS_NFT|g" \
    -e "s|BADGE_NFT_PLACEHOLDER|$BADGE_NFT|g" \
    -e "s|startBlock: 0|startBlock: $START_BLOCK|g" \
    subgraph.yaml

  npm install --silent
  npm run codegen --silent
  npm run build   --silent
  if [[ "$NETWORK" == "mainnet" ]]; then
    echo "▶ deploying subgraph to Graph Studio ($SUBGRAPH_NAME)"
    npm run deploy:base
  else
    echo "ℹ subgraph built but not deployed (sepolia)"
  fi
fi

# ──────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────
cat <<EOF

═══════════════════════════════════════════════════════════════
 ✅ MemePred deployed on $NETWORK (chainId=$CHAIN_ID)
═══════════════════════════════════════════════════════════════

  FeeDistributor:   $FEE_DISTRIBUTOR
  ReferralRegistry: $REFERRAL_REGISTRY
  OracleResolver:   $ORACLE_RESOLVER
  GenesisNFT:       $GENESIS_NFT
  LiquidityPool:    $LIQUIDITY_POOL
  MarketFactory:    $MARKET_FACTORY
  BadgeNFT:         $BADGE_NFT

  startBlock:       $START_BLOCK

Next steps:
  1. Fund keeper hot-wallet with ETH:
       cast send $KEEPER_ADDRESS --value 0.05ether ...
  2. Fund OracleResolver with ETH (for Pyth update fees):
       cast send $ORACLE_RESOLVER --value 0.02ether ...
  3. Seed LP liquidity (≥100 USDC) so first matches can happen.
  4. On the server:
       cd deploy && docker compose up -d
  5. Deploy frontend:
       cd frontend && vercel deploy --prod
  6. Create first market (from MULTISIG or owner):
       cast send $MARKET_FACTORY 'createMarket(bytes32,uint256)' \\
         0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4 \\
         900 ...

EOF
