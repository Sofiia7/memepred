#!/bin/bash
set -e

echo "Starting anvil in background..."
anvil --port 8545 > anvil_out.log 2>&1 &
ANVIL_PID=$!
sleep 2

export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export MULTISIG_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
export KEEPER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

echo "Deploying mock USDC and Pyth..."
# Actually Deploy.s.sol uses hardcoded Base Mainnet USDC/Pyth. So we can't use it on plain Anvil without --fork-url
# Let's restart anvil with fork if possible, but let's just make a modified script for local test.

kill $ANVIL_PID
