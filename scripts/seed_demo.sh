#!/usr/bin/env bash
# Seeds a good-looking demo jar on a LOCAL arc-anvil fork (for screenshots). Never use on a real network.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.testnet; set +a
RPC_URL=${RPC_URL:-http://127.0.0.1:8545}
CAST=$(command -v arc-cast || command -v cast)
FACTORY=$(python3 -c "import json;print(json.load(open('deployments/e2e-arc-testnet-fork.json'))['factory'])")
"$CAST" rpc anvil_setBalance "$PAYER_ADDR" 0x152D02C7E14AF6800000 --rpc-url "$RPC_URL" >/dev/null # 100k USDC
"$CAST" rpc anvil_setBalance "$TESTNET_ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null
b32() { "$CAST" --format-bytes32-string "$1"; }
NOW=$("$CAST" block latest -f timestamp --rpc-url "$RPC_URL")
TAXDAY=$("$CAST" block latest -f timestamp --rpc-url "$RPC_URL" | python3 -c "import sys,datetime as d;n=int(sys.stdin.read());t=d.datetime(2027,4,15,tzinfo=d.timezone.utc).timestamp();print(int(t))")
SAVE=$((NOW + 30*86400))
SALT=$("$CAST" keccak "demo-$NOW")
Z=0x0000000000000000000000000000000000000000
JAR=$("$CAST" call "$FACTORY" "predictJar(address,bytes32)(address)" "$TESTNET_ADDR" "$SALT" --rpc-url "$RPC_URL")
"$CAST" send --rpc-url "$RPC_URL" --private-key "$TESTNET_PK" "$FACTORY" "createJar(bytes32,(bytes32,uint16,uint64,address)[])" "$SALT" \
  "[($(b32 Tax),2500,$TAXDAY,$Z),($(b32 Profit),500,0,$Z),($(b32 'Emergency fund'),1000,$SAVE,$Z)]" >/dev/null
for amt in 1200 350 80; do "$CAST" send --rpc-url "$RPC_URL" --private-key "$PAYER_PK" "$JAR" --value ${amt}ether >/dev/null; done
"$CAST" send --rpc-url "$RPC_URL" --private-key "$PAYER_PK" 0x3600000000000000000000000000000000000000 "transfer(address,uint256)" "$JAR" 45000000 >/dev/null
echo "$JAR"
