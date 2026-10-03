#!/usr/bin/env bash
# FULL-STACK local integration: real contract + real Next server + real registration route
# (with on-chain verification) + the real trigger worker, all on a local Anvil chain.
# Every write goes through the real wallet-signature auth (cast wallet sign = EIP-191
# personal_sign, the same thing the browser wallet produces). The contract enforces the
# weekday (UTC), once-per-day and the balance condition, and this script drives the
# real routes, the real worker and the real contract to prove it.
# Needs: foundry, `npm install` in frontend/ and backend/, and contracts/lib populated
# (see contracts/README.md). Uses Anvil's PUBLIC dev keys only: never use them anywhere real.
# Sandbox-only flags (offline solc) can be passed via FORGE_EXTRA.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RPC=http://127.0.0.1:8545
DEP=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EXEC_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
EXEC_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
USER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
USER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
OTHER=0x90F79bf6EB2c4f870365E785982E1f101E93b906     # also the default "savings" recipient
OTHER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
EXTRA="${FORGE_EXTRA:-}"
DB="$(mktemp -d)/automations.json"
cleanup(){ kill $NEXT_PID $ANVIL_PID 2>/dev/null; }
trap cleanup EXIT
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
bad(){ echo "  FAIL: $1"; fail=$((fail+1)); }
expect(){ [ "$2" = "$3" ] && ok "$1 ($2)" || bad "$1 (got '$2', wanted '$3')"; }

anvil --chain-id 421614 --silent & ANVIL_PID=$!
for i in $(seq 1 20); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
cd $ROOT/contracts
PULSE=$(EXECUTOR_ADDRESS=$EXEC_ADDR forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --private-key $DEP --broadcast $EXTRA 2>&1 | grep "deployed at" | awk '{print $NF}')
USDC=$(forge create test/PulseAutomation.t.sol:MockUSDC --rpc-url $RPC --private-key $DEP --broadcast $EXTRA 2>&1 | grep "Deployed to" | awk '{print $NF}')
echo "pulse=$PULSE usdc=$USDC"
cast send --rpc-url $RPC --private-key $DEP $USDC "mint(address,uint256)" $USER 250000000 >/dev/null
cast send --rpc-url $RPC --private-key $USER_KEY $USDC "approve(address,uint256)" $PULSE 100000000 >/dev/null

EXP_ISO=$(date -u -d "+1 year" +%Y-%m-%dT%H:%M:%SZ); EXP=$(date -u -d "$EXP_ISO" +%s)
TODAY=$(date -u +%A | tr A-Z a-z); TOMORROW=$(date -u -d tomorrow +%A | tr A-Z a-z)
TODAY_NUM=$(date -u +%w); TOMORROW_NUM=$(( (TODAY_NUM + 1) % 7 ))   # contract: 0 = Sunday .. 6 = Saturday, UTC
mkperm(){ # weekday op(0=GT,1=GTE,..) threshold(base units)
  cast send --rpc-url $RPC --private-key $USER_KEY $PULSE "createPermission(address,address,uint256,uint256,uint256,uint256,uint8,uint8,uint256)" $USDC $OTHER 10000000 10000000 604800 $EXP $1 $2 $3 >/dev/null; }
mkperm $TODAY_NUM    0 100000000    # id 0: today,    >  100  (worker sends)
mkperm $TODAY_NUM    0 1000000000   # id 1: today,    > 1000  (condition not met)
mkperm $TOMORROW_NUM 0 100000000    # id 2: tomorrow, >  100  (wrong weekday today)
mkperm $TOMORROW_NUM 0 100000000    # id 3: tomorrow, >  100  (registration refusal tests)
mkperm $TOMORROW_NUM 0 100000000    # id 4: tomorrow  (registered below with the WRONG weekday)
mkperm $TOMORROW_NUM 1 100000000    # id 5: tomorrow, >= 100  (registered below with the WRONG operator)
mkperm $TOMORROW_NUM 0 99000000     # id 6: tomorrow, >   99  (registered below with the WRONG threshold)
mkperm $TODAY_NUM    0 100000000    # id 7: today,    >  100  (used for the manual-fire success)

cd $ROOT/frontend
export ARBITRUM_SEPOLIA_RPC_URL=$RPC PULSE_CONTRACT_ADDRESS=$PULSE NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS=$PULSE EXECUTOR_PRIVATE_KEY=$EXEC_KEY NEXT_PUBLIC_USDC_ADDRESS=$USDC PULSE_DB_PATH=$DB
npx next dev -p 3055 > /tmp/next.log 2>&1 & NEXT_PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:3055/api/automations && break; sleep 1; done

ms(){ date +%s%3N; }   # unix milliseconds (GNU date), what the auth window expects
signer_key(){ [ "$1" = "$OTHER" ] && echo $OTHER_KEY || echo $USER_KEY; }
reg(){ # id owner day threshold [maxPerExec] [maxPerWindow] [clientTz]   (signed by `owner`'s key)
  local T=$(ms) SIG
  SIG=$(cast wallet sign --private-key $(signer_key $2) "$(printf 'Pulse: register automation\nonchainId: %s\nowner: %s\ntimestamp: %s' "$1" "$2" "$T")")
  curl -s -X POST localhost:3055/api/automations -H 'content-type: application/json' -d "{
   \"onchainId\":\"$1\",\"owner\":\"$2\",\"userId\":\"demo\",\"timezone\":\"${7:-UTC}\",\"signature\":\"$SIG\",\"timestamp\":$T,
   \"intent\":{\"trigger\":{\"type\":\"schedule\",\"frequency\":\"weekly\",\"day\":\"$3\"},
    \"condition\":{\"asset\":\"USDC\",\"operator\":\"${OP:->}\",\"balance\":\"$4\"},
    \"action\":{\"type\":\"transfer\",\"asset\":\"USDC\",\"amount\":\"10\"},
    \"recipientId\":\"savings\",\"maxPerExecution\":\"${5:-10}\",\"maxPerWindow\":\"${6:-10}\",\"expiresAt\":\"$EXP_ISO\"}}"; }
act(){ # automationId action   (signed by the automation owner = USER)
  local T=$(ms) SIG
  SIG=$(cast wallet sign --private-key $USER_KEY "$(printf 'Pulse: %s automation\nid: %s\ntimestamp: %s' "$2" "$1" "$T")")
  curl -s -X POST localhost:3055/api/execute -H 'content-type: application/json' -d "{\"userId\":\"demo\",\"automationId\":\"$1\",\"action\":\"$2\",\"signature\":\"$SIG\",\"timestamp\":$T}"; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" ; }

echo "== REGISTRATION (signed, and verified against the chain) =="
R=$(reg 0 $USER $TODAY 100);            expect "valid permission registers, verified=true" "$(echo "$R" | field "d.get('ok'),d.get('verified')")" "True True"
R=$(reg 1 $USER $TODAY 1000);           expect "second permission (condition too high) registers" "$(echo "$R" | field "d.get('ok')")" "True"
R=$(reg 2 $USER $TOMORROW 100);         expect "third permission (other weekday) registers" "$(echo "$R" | field "d.get('ok')")" "True"
R=$(reg 0 $USER $TODAY 100);            expect "re-registering is idempotent, not duplicated" "$(echo "$R" | field "d.get('alreadyRegistered')")" "True"
R=$(reg 99 $USER $TODAY 100);           expect "nonexistent on-chain id is refused" "$(echo "$R" | field "d.get('reason')")" "No such permission on-chain."
R=$(reg 3 $OTHER $TOMORROW 100);        expect "wrong owner is refused" "$(echo "$R" | field "d.get('reason')")" "That permission belongs to a different wallet."
R=$(reg 3 $USER $TOMORROW 100 10 20);   expect "caps that differ from on-chain are refused" "$(echo "$R" | field "d.get('reason')")" "On-chain caps do not match."
R=$(reg 4 $USER $TODAY 100);            expect "a weekday that differs from on-chain is refused" "$(echo "$R" | field "d.get('reason')")" "On-chain weekday does not match."
R=$(OP=">" reg 5 $USER $TOMORROW 100);  expect "an operator that differs from on-chain is refused" "$(echo "$R" | field "d.get('reason')")" "On-chain balance condition does not match."
R=$(reg 6 $USER $TOMORROW 100);         expect "a threshold that differs from on-chain is refused" "$(echo "$R" | field "d.get('reason')")" "On-chain balance condition does not match."
R=$(reg 3 $USER $TOMORROW 100 10 10 "Africa/Lagos"); expect "client-supplied timezone is ignored: always stored as UTC" "$(echo "$R" | field "d['automation']['timezone']")" "UTC"
# Auth still guards registration (unchanged by this feature, but it is what the routes now require)
R=$(curl -s -X POST localhost:3055/api/automations -H 'content-type: application/json' -d '{"onchainId":"7","owner":"'$USER'","userId":"demo","intent":{}}')
expect "unsigned registration is refused" "$(echo "$R" | field "d.get('ok')")" "False"

echo "== WORKER: poll #1 =="
cd $ROOT/backend
npx tsx scripts/e2e-worker.ts 2>&1 | sed 's/^/  /'
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "recipient received exactly 10 USDC (only the due+eligible automation ran)" "$BAL" "10000000"
runstate(){ python3 -c "
import json;d=json.load(open('$DB'));r=[x for x in d if x['onchainId']=='$1'][0]
print(r.get('run',{}).get('state'), (r.get('lastExecution') or {}).get('status'))"; }
expect "#0 (due, condition met) -> done/success" "$(runstate 0)" "done success"
expect "#1 (condition not met) -> untouched" "$(runstate 1)" "None None"
expect "#2 (wrong weekday)     -> untouched" "$(runstate 2)" "None None"

echo "== WORKER: poll #2 (same day, must not send again) =="
npx tsx scripts/e2e-worker.ts 2>&1 | sed 's/^/  /'
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "still exactly 10 USDC after a second poll" "$BAL" "10000000"

echo "== MANUAL FIRE: the contract is the gatekeeper, not the schedule check =="
# "fire" skips the worker's own pre-checks and submits execute() straight away, so every
# refusal below is the CONTRACT saying no.
F=$(act demo-0 fire)
expect "fire on #0 (already sent today) is refused on-chain" "$(echo "$F" | field "d.get('outcome'), d.get('reason')")" "rejected Already executed for this UTC day"
F=$(act demo-2 fire)
expect "fire on #2 (wrong weekday) is refused on-chain" "$(echo "$F" | field "d.get('outcome'), d.get('reason')")" "rejected Not the scheduled day (UTC)"
F=$(act demo-1 fire)
expect "fire on #1 (balance condition unmet) is refused on-chain" "$(echo "$F" | field "d.get('outcome'), d.get('reason')")" "rejected Balance condition not met"
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "none of those refused fires moved funds" "$BAL" "10000000"
expect "a refused fire is NOT counted as the day's run (#1 stays free for the worker)" "$(runstate 1)" "None rejected"

R=$(reg 7 $USER $TODAY 100);            expect "permission #7 (today, condition met) registers" "$(echo "$R" | field "d.get('ok')")" "True"
F=$(act demo-7 fire)
expect "fire on #7 (right day, condition met) sends" "$(echo "$F" | field "d.get('outcome')")" "success"
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "recipient now 20 USDC" "$BAL" "20000000"
expect "a fire that sent IS counted as today's run" "$(runstate 7)" "done success"
npx tsx scripts/e2e-worker.ts 2>&1 | sed 's/^/  /'
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "worker does not repeat a day that manual fire already used (still 20 USDC)" "$BAL" "20000000"

echo "== ON-CHAIN CANCEL, THEN WORKER =="
cast send --rpc-url $RPC --private-key $USER_KEY $PULSE "cancel(uint256)" 1 >/dev/null
python3 - <<PY
import json;p='$DB';d=json.load(open(p))
for r in d:
    if r['onchainId']=='1': r['condition']['thresholdBaseUnits']='0'   # make it eligible so only the chain can stop it
json.dump(d,open(p,'w'))
PY
cd $ROOT/backend && npx tsx scripts/e2e-worker.ts 2>&1 | sed 's/^/  /'
expect "cancelled-on-chain permission: worker's send was REJECTED by the contract" "$(python3 -c "
import json;d=json.load(open('$DB'));r=[x for x in d if x['onchainId']=='1'][0];print((r.get('lastExecution') or {}).get('status'),'|',(r.get('lastExecution') or {}).get('reason'))")" "rejected | Permission cancelled"
BAL=$(cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $OTHER | awk '{print $1}')
expect "no funds moved by the cancelled permission" "$BAL" "20000000"

echo; echo "RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
