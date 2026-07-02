#!/usr/bin/env bash
# check-testnet.sh — read-only готовность к соаку (Base Sepolia).
# Не тратит газ. Требует: git bash + foundry (cast). Запуск:
#   bash scripts/check-testnet.sh
set -uo pipefail

CAST="${CAST:-$HOME/.foundry/bin/cast}"
RPC="${BASE_RPC_URL:-https://sepolia.base.org}"

# Контракты берём из deploy/.env — это ЖИВОЙ набор (frontend + docker keeper).
ENVF="$(dirname "$0")/../deploy/.env"
USDC=$(grep -E '^USDC_ADDRESS=' "$ENVF" | cut -d= -f2)
FACTORY=$(grep -E '^MARKET_FACTORY=' "$ENVF" | cut -d= -f2)
RESOLVER=$(grep -E '^ORACLE_RESOLVER=' "$ENVF" | cut -d= -f2)

echo "RPC=$RPC"
echo "FACTORY=$FACTORY   RESOLVER=$RESOLVER   USDC=$USDC"
echo

# name:address (публичные адреса — приватные ключи тут не нужны)
WALLETS=(
  "deployer:0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2"
  "keeper:0xbFa008e5A8d46d2014b83551ce6209108416eea4"
  "badge-minter:0xb183b09f0D41314EA597598B741b41bcddd875e6"
  "bot1:0x6E32C4c56Ca8E1a6756bDD92C61191Bc16801895"
  "bot2:0xfd4385DE94CFfd3E3F9E4E508C7DE34AAEc8dF48"
  "bot3:0x5248bFfEf0B54f3Cd2102c285D32149a5A3c63F1"
)

printf "%-13s %-44s %12s %10s %6s\n" "wallet" "address" "ETH" "USDC" "nonce"
for pair in "${WALLETS[@]}"; do
  name=${pair%%:*}; addr=${pair##*:}
  eth=$("$CAST" balance "$addr" --rpc-url "$RPC" --ether 2>/dev/null)
  usdc_raw=$("$CAST" call "$USDC" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
  usdc=$(awk "BEGIN{printf \"%.2f\", ${usdc_raw:-0}/1000000}")
  nonce=$("$CAST" nonce "$addr" --rpc-url "$RPC" 2>/dev/null)
  printf "%-13s %-44s %12.6f %10s %6s\n" "$name" "$addr" "${eth:-0}" "$usdc" "${nonce:-?}"
done

echo
echo "=== ЖИВЫЕ РЫНКИ (factory.getActiveMarkets) ==="
feeds=$("$CAST" call "$FACTORY" "getAllFeedIds()(bytes32[])" --rpc-url "$RPC" 2>/dev/null)
echo "feeds: $feeds"
echo "$feeds" | tr -d '[]' | tr ',' '\n' | while read -r fid; do
  fid=$(echo "$fid" | xargs); [ -z "$fid" ] && continue
  markets=$("$CAST" call "$FACTORY" "getActiveMarkets(bytes32)(address[])" "$fid" --rpc-url "$RPC" 2>/dev/null)
  echo "  feed $fid -> $markets"
  echo "$markets" | tr -d '[]' | tr ',' '\n' | while read -r mk; do
    mk=$(echo "$mk" | xargs); [ -z "$mk" ] && continue
    next=$("$CAST" call "$mk" "nextOrderId()(uint256)" --rpc-url "$RPC" 2>/dev/null)
    orders=$(( ${next:-1} - 1 ))
    ready=$("$CAST" call "$mk" "getReadySettlements(uint256,uint256)(uint256[])" 0 25 --rpc-url "$RPC" 2>/dev/null)
    echo "      market $mk  orders=$orders  ready_to_settle=$ready"
  done
done
