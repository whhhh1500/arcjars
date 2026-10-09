#!/usr/bin/env bash
# End-to-end ArcJars run: deploy -> create jar -> native pay (auto-split) ->
# ERC-20 pay + Memo-tagged pay (sweep) -> 21000-gas pay -> time lock -> withdraw -> fees.
# Usage: RPC_URL=http://127.0.0.1:8545 FORK=1 scripts/e2e.sh     (arc-anvil fork of Arc testnet)
#        RPC_URL=https://rpc.testnet.arc.io scripts/e2e.sh        (real testnet; keys must be funded)
# Keys come from .env.testnet (TESTNET_PK = deployer/jar owner/keeper, PAYER_PK = customer). Never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.testnet; set +a
RPC_URL=${RPC_URL:-http://127.0.0.1:8545}
FORK=${FORK:-0}
CAST=${CAST:-$(command -v arc-cast || command -v cast)}
FORGE=${FORGE:-$(command -v arc-forge || command -v forge)}
USDC=0x3600000000000000000000000000000000000000
MEMO=0x5294E9927c3306DcBaDb03fe70b92e01cCede505
FEE_RECIPIENT=${FEE_RECIPIENT:-0xc7AC1469a8dc7E4df3CE2D646dd6D01296548CEd}
OUTFILE=${OUTFILE:-deployments/e2e-$( [ "$FORK" = 1 ] && echo arc-testnet-fork || echo arc-testnet ).json}
GAS=(--rpc-url "$RPC_URL")
declare -A TX
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
usdc() { python3 -c "print(f'{int(\"$1\".split()[0])/1e18:,.6f} USDC')"; }
send() { # send <name> <pk> <args...>  -> records tx hash
  local name=$1 pk=$2; shift 2
  local out; out=$("$CAST" send "${GAS[@]}" --private-key "$pk" --json "$@")
  local h st; h=$(echo "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  st=$(echo "$out" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['status'],16))")
  TX[$name]=$h; echo "  $name: $h (status $st)"; [ "$st" = 1 ]
}
bal() { "$CAST" balance "$1" --rpc-url "$RPC_URL"; }

if [ "$FORK" = 1 ]; then
  log "Fork mode: funding throwaway keys with anvil_setBalance (no real funds)"
  for a in "$TESTNET_ADDR" "$PAYER_ADDR"; do
    "$CAST" rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null # 100 USDC
  done
fi
echo "  owner $(bal $TESTNET_ADDR | xargs -I{} python3 -c 'print({}/1e18)') USDC, payer $(bal $PAYER_ADDR | xargs -I{} python3 -c 'print({}/1e18)') USDC"

log "1. Deploy ArcJarFactory"
pushd contracts >/dev/null
FEE_RECIPIENT=$FEE_RECIPIENT "$FORGE" script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$TESTNET_PK" --broadcast --slow -q >/dev/null 2>&1
CHAIN=$("$CAST" chain-id --rpc-url "$RPC_URL")
RUN=broadcast/Deploy.s.sol/$CHAIN/run-latest.json
FACTORY=$(python3 -c "import json;r=json.load(open('$RUN'));print([t['contractAddress'] for t in r['transactions'] if t['contractName']=='ArcJarFactory'][0])")
TX[deployFactory]=$(python3 -c "import json;r=json.load(open('$RUN'));print(r['receipts'][0]['transactionHash'])")
popd >/dev/null
IMPL=$("$CAST" call "$FACTORY" "implementation()(address)" --rpc-url "$RPC_URL")
echo "  factory $FACTORY  implementation $IMPL  tx ${TX[deployFactory]}"

log "2. Owner creates a jar: Tax 25% (locked 1h), Profit 5%, Spendable 70%"
NOW=$("$CAST" block latest -f timestamp --rpc-url "$RPC_URL"); UNLOCK=$((NOW + 3600))
TAX=$("$CAST" --format-bytes32-string Tax); PROFIT=$("$CAST" --format-bytes32-string Profit)
SALT=$("$CAST" keccak "e2e-$NOW")
PRED=$("$CAST" call "$FACTORY" "predictJar(address,bytes32)(address)" "$TESTNET_ADDR" "$SALT" --rpc-url "$RPC_URL")
send createJar "$TESTNET_PK" "$FACTORY" "createJar(bytes32,(bytes32,uint16,uint64,address)[])" "$SALT" "[($TAX,2500,$UNLOCK,0x0000000000000000000000000000000000000000),($PROFIT,500,0,0x0000000000000000000000000000000000000000)]"
JAR=$PRED; echo "  jar $JAR (predicted before creation)"
jars() { "$CAST" call "$JAR" "jars()(bytes32[],uint256[],uint16[],uint64[],address[])" --rpc-url "$RPC_URL" | sed -n 2p; }

log "3. Native USDC payment (wallet-estimated gas) -> split inside receive()"
EST=$("$CAST" estimate "$JAR" --value 10ether --from "$PAYER_ADDR" --rpc-url "$RPC_URL"); echo "  eth_estimateGas for a 10 USDC native send: $EST"
send nativePay "$PAYER_PK" "$JAR" --value 10ether
echo "  jar balances [Spendable, Tax, Profit] = $(jars); unallocated $("$CAST" call $JAR 'unallocated()(uint256)' --rpc-url $RPC_URL)"

log "4. Same balance, two interfaces: ERC-20 transfer of 4 USDC (6 decimals) -> no receive(), needs sweep"
B0=$(bal $JAR); E0=$("$CAST" call $USDC "balanceOf(address)(uint256)" $JAR --rpc-url $RPC_URL | awk '{print $1}')
send erc20Pay "$PAYER_PK" $USDC "transfer(address,uint256)" "$JAR" 4000000
B1=$(bal $JAR); E1=$("$CAST" call $USDC "balanceOf(address)(uint256)" $JAR --rpc-url $RPC_URL | awk '{print $1}')
python3 -c "b0,b1,e0,e1=$B0,$B1,$E0,$E1;print(f'  native  {b0} -> {b1} (+{b1-b0} wei, 18 dp)');print(f'  erc20   {e0} -> {e1} (6 dp)  balanceOf == native // 1e12: {e1 == b1 // 10**12}')"
echo "  unallocated $("$CAST" call $JAR 'unallocated()(uint256)' --rpc-url $RPC_URL)"
send sweep1 "$TESTNET_PK" "$JAR" "sweep()"
echo "  after sweep: $(jars)"

log "5. Memo-tagged invoice payment (Arc Memo contract wraps USDC.transfer)"
INV=$("$CAST" keccak "INV-2026-001"); DATA=$("$CAST" calldata "transfer(address,uint256)" "$JAR" 2000000)
send memoPay "$PAYER_PK" $MEMO "memo(address,bytes,bytes32,bytes)" $USDC "$DATA" "$INV" "$("$CAST" from-utf8 'invoice=INV-2026-001')"
MEMOLOG=$("$CAST" receipt "${TX[memoPay]}" --rpc-url "$RPC_URL" --json | python3 -c "
import json,sys; r=json.load(sys.stdin)
print(sum(1 for l in r['logs'] if l['address'].lower()=='$MEMO'.lower() and len(l['topics'])>3 and l['topics'][3].lower()=='$INV'.lower()))")
echo "  Memo events with memoId=keccak('INV-2026-001'): $MEMOLOG"
send sweep2 "$TESTNET_PK" "$JAR" "sweep()"

log "6. Exchange-style plain transfer with a fixed 21000 gas limit"
set +e
OUT21=$("$CAST" send "${GAS[@]}" --private-key "$PAYER_PK" --json --gas-limit 21000 "$JAR" --value 1ether 2>&1); RC=$?
set -e
ST21=$(echo "$OUT21" | python3 -c "import json,sys;s=sys.stdin.read();print(json.loads(s[s.index('{'):]).get('status','?') if '{' in s else 'not-mined')" 2>/dev/null || echo error)
H21=$(echo "$OUT21" | python3 -c "import json,sys;s=sys.stdin.read();print(json.loads(s[s.index('{'):]).get('transactionHash',''))" 2>/dev/null || true)
[ -n "$H21" ] && TX[fixed21000Transfer]=$H21
echo "  exit=$RC status=$ST21 tx=$H21 (status 0x0 = reverted out-of-gas: payer keeps the USDC, pays ~21000 gas)"
echo "$OUT21" > /tmp/arcjars-21000.txt

log "7. Withdraw Spendable; Tax is time-locked"
send withdrawSpendable "$TESTNET_PK" "$JAR" "withdraw(uint256,uint256,address)" 0 3000000000000000000 "$TESTNET_ADDR"
set +e; "$CAST" call "$JAR" "withdraw(uint256,uint256,address)" 1 1 "$TESTNET_ADDR" --from "$TESTNET_ADDR" --rpc-url "$RPC_URL" >/tmp/lock.txt 2>&1; set -e
echo "  withdraw(Tax) before unlock -> $(grep -q 0xeada2658 /tmp/lock.txt && echo 'reverted: Locked(unlockAt)' || head -c 120 /tmp/lock.txt)"
if [ "$FORK" = 1 ]; then
  "$CAST" rpc evm_increaseTime 3601 --rpc-url "$RPC_URL" >/dev/null; "$CAST" rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
  send withdrawTax "$TESTNET_PK" "$JAR" "withdraw(uint256,uint256,address)" 1 115792089237316195423570985008687907853269984665640564039457584007913129639935 "$TESTNET_ADDR"
fi

log "8. Anyone collects protocol fees -> feeRecipient"
F0=$(bal $FEE_RECIPIENT); send collectFees "$TESTNET_PK" "$JAR" "collectFees()"; F1=$(bal $FEE_RECIPIENT)
echo "  feeRecipient +$((F1-F0)) wei"
echo "  final jars: $(jars); allocated $("$CAST" call $JAR 'allocated()(uint256)' --rpc-url $RPC_URL); native balance $(bal $JAR)"

python3 - "$OUTFILE" <<PY
import json,sys
tx = {$(for k in "${!TX[@]}"; do printf '"%s":"%s",' "$k" "${TX[$k]}"; done)}
json.dump({"network": "arc-testnet" + ("-fork (arc-anvil --network arc --fork-url https://rpc.testnet.arc.io)" if "$FORK"=="1" else ""),
  "chainId": $CHAIN, "rpc": "$RPC_URL", "factory": "$FACTORY", "implementation": "$IMPL", "jar": "$JAR",
  "owner": "$TESTNET_ADDR", "payer": "$PAYER_ADDR", "feeRecipient": "$FEE_RECIPIENT",
  "estimateGasNativePay": $EST, "fixed21000Transfer": {"status": "$ST21"}, "tx": tx}, open(sys.argv[1],"w"), indent=2)
print("  wrote", sys.argv[1])
PY
