#!/usr/bin/env bash
# Local end-to-end check: Anvil (Arbitrum Sepolia chain id) -> deploy Pulse + mock USDC
# -> user creates a permission -> backend chain.ts executes as the executor.
# Uses Anvil's PUBLIC, well-known dev keys. Never use these anywhere real.
# Sandbox-only flags (offline solc) can be passed via FORGE_EXTRA.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=http://127.0.0.1:8545
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EXECUTOR_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
EXECUTOR_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
USER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
USER_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
RECIPIENT=0x90F79bf6EB2c4f870365E785982E1f101E93b906
EXTRA="${FORGE_EXTRA:-}"

pkill anvil 2>/dev/null || true; sleep 1
anvil --chain-id 421614 --silent & ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 3

PULSE=$(EXECUTOR_ADDRESS=$EXECUTOR_ADDR forge script script/Deploy.s.sol:Deploy \
  --rpc-url $RPC --private-key $DEPLOYER_KEY --broadcast $EXTRA 2>&1 \
  | grep "deployed at" | awk '{print $NF}')
USDC=$(forge create test/PulseAutomation.t.sol:MockUSDC --rpc-url $RPC --private-key $DEPLOYER_KEY \
  --broadcast $EXTRA 2>&1 | grep "Deployed to" | awk '{print $NF}')
echo "Pulse: $PULSE"; echo "USDC:  $USDC"

cast send $USDC "mint(address,uint256)" $USER_ADDR 1000000000 --rpc-url $RPC --private-key $DEPLOYER_KEY >/dev/null
cast send $USDC "approve(address,uint256)" $PULSE 10000000 --rpc-url $RPC --private-key $USER_KEY >/dev/null
EXPIRES=$(( $(date +%s) + 31536000 ))
# The contract enforces the weekday in UTC (0 = Sunday .. 6 = Saturday) and a balance condition.
# Anvil's block time follows the wall clock, so "today" here is the contract's "today".
TODAY_NUM=$(date -u +%w); OTHER_NUM=$(( (TODAY_NUM + 1) % 7 ))
mkperm(){ # weekday op threshold   (cap 10 USDC per execution and per week, 1 week window)
  cast send $PULSE "createPermission(address,address,uint256,uint256,uint256,uint256,uint8,uint8,uint256)" \
    $USDC $RECIPIENT 10000000 10000000 604800 $EXPIRES $1 $2 $3 --rpc-url $RPC --private-key $USER_KEY >/dev/null; }
mkperm $TODAY_NUM 0 100000000     # id 0: today,     balance >  100 USDC (met: user has 1000)
mkperm $TODAY_NUM 0 5000000000    # id 1: today,     balance > 5000 USDC (NOT met)
mkperm $OTHER_NUM 0 100000000     # id 2: tomorrow,  balance >  100 USDC (wrong weekday)
mkperm $TODAY_NUM 0 100000000     # id 3: today,     for the per-execution-cap check

export ARBITRUM_SEPOLIA_RPC_URL=$RPC PULSE_CONTRACT_ADDRESS=$PULSE EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY
( cd ../backend && npx tsx scripts/e2e-local.ts )

BAL=$(cast call $USDC "balanceOf(address)(uint256)" $RECIPIENT --rpc-url $RPC | awk '{print $1}')
echo "recipient balance: $BAL (expected 10000000)"
[ "$BAL" = "10000000" ] && echo "RECIPIENT BALANCE OK"

# Real revocation: user cancels on-chain, executor can no longer move anything.
cast send $PULSE "cancel(uint256)" 0 --rpc-url $RPC --private-key $USER_KEY >/dev/null
# getPermission returns 14 fields; status is the 10th (0 Active, 1 Paused, 2 Cancelled, 3 Expired).
STATUS=$(cast call $PULSE "getPermission(uint256)(address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint8,uint256,uint256)" 0 --rpc-url $RPC | sed -n 10p | awk '{print $1}')
echo "on-chain status after cancel: $STATUS (2 = Cancelled)"
[ "$STATUS" = "2" ] || { echo "FAIL: permission is not Cancelled on-chain"; exit 1; }
( cd ../backend && npx tsx scripts/e2e-local.ts after-cancel )
echo "ALL E2E CHECKS PASSED"
