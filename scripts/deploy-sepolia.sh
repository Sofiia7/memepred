#!/usr/bin/env bash
# Deploy FlipTheMeme stack to Base Sepolia and write the resulting addresses back
# to ../.env so backend, keeper and frontend pick them up automatically.
#
# Usage:  ./scripts/deploy-sepolia.sh
# Requires: forge, jq, awk; .env with PRIVATE_KEY (deployer) and ≥0.001 ETH on
#           Base Sepolia for that key.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

# Load Sepolia section only — grep just sepolia-relevant lines from .env.
# (The .env contains both Mainnet and Sepolia stanzas; later assignments win
#  with `set -a; source`.)
set -a
source "$ROOT/.env"
set +a

: "${PRIVATE_KEY:?PRIVATE_KEY missing}"
: "${MULTISIG_ADDRESS:?MULTISIG_ADDRESS missing}"
: "${TREASURY_ADDRESS:?TREASURY_ADDRESS missing}"
: "${KEEPER_ADDRESS:?KEEPER_ADDRESS missing}"

# These three are optional in .env — default them to TREASURY_ADDRESS.
export LP_FEE_SINK_ADDRESS="${LP_FEE_SINK_ADDRESS:-$TREASURY_ADDRESS}"
export NFT_REWARDS_ADDRESS="${NFT_REWARDS_ADDRESS:-$TREASURY_ADDRESS}"
export BADGE_MINTER_ADDRESS="${BADGE_MINTER_ADDRESS:-$KEEPER_ADDRESS}"

echo "Deploying to Base Sepolia..."
echo "  deployer: $(cast wallet address --private-key "$PRIVATE_KEY")"
echo "  balance:  $(cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url https://sepolia.base.org -e) ETH"

forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --slow \
  -vv 2>&1 | tee /tmp/flipthememe-deploy.log

# Pull addresses out of the broadcast artifact.
ART="$ROOT/contracts/broadcast/Deploy.s.sol/84532/run-latest.json"
echo ""
echo "Updating $ROOT/.env with new Sepolia addresses..."

extract() {
  # $1 = label printed in script (e.g. "FEE_DISTRIBUTOR=")
  grep -E "^  $1" /tmp/flipthememe-deploy.log | head -1 | awk -F= '{print $2}' | tr -d ' '
}

FEE_DISTRIBUTOR=$(extract "FEE_DISTRIBUTOR=")
REFERRAL_REGISTRY=$(extract "REFERRAL_REGISTRY=")
ORACLE_RESOLVER=$(extract "ORACLE_RESOLVER=")
GENESIS_NFT=$(extract "GENESIS_NFT=")
LIQUIDITY_POOL=$(extract "LIQUIDITY_POOL=")
MARKET_FACTORY=$(extract "MARKET_FACTORY=")
BADGE_NFT=$(extract "BADGE_NFT=")

# Replace the Sepolia stanza addresses in-place.
ENV_FILE="$ROOT/.env"
for var in FEE_DISTRIBUTOR REFERRAL_REGISTRY ORACLE_RESOLVER GENESIS_NFT LIQUIDITY_POOL MARKET_FACTORY BADGE_NFT; do
  val="${!var}"
  if [ -z "$val" ]; then
    echo "  ! could not extract $var from deploy log; skipping"
    continue
  fi
  # Update the LAST occurrence (Sepolia stanza is at the bottom).
  awk -v k="$var" -v v="$val" '
    { lines[NR] = $0; if ($0 ~ "^" k "=") last = NR }
    END {
      for (i = 1; i <= NR; i++) {
        if (i == last) print k "=" v
        else           print lines[i]
      }
    }
  ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "  $var = $val"
done

echo ""
echo "Done. Addresses written to .env."
echo "Next:"
echo "  1. cd subgraph && update subgraph.yaml startBlock + addresses, then 'graph deploy'"
echo "  2. cd deploy && docker compose up -d"
