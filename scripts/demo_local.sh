#!/usr/bin/env bash
# Spin up a throwaway local Arc chain (arc-anvil), deploy ArcJars and seed two demo jars
# (EN + 中文) for screenshots / judging. Uses only anvil's public dev keys. Never touches a real network.
#   scripts/demo_local.sh            -> prints FACTORY / owners; leaves arc-anvil running on :8545
set -euo pipefail
cd "$(dirname "$0")/../contracts"
R=${RPC_URL:-http://127.0.0.1:8545}
C=$(command -v arc-cast || command -v cast)
F=$(command -v arc-forge || command -v forge)
MN="test test test test test test test test test test test junk"
if ! "$C" chain-id --rpc-url "$R" >/dev/null 2>&1; then
  arc-anvil --network arc --chain-id 5042002 --port "${R##*:}" >/tmp/arcjars-anvil.log 2>&1 &
  sleep 3
fi
[[ "$("$C" chain-id --rpc-url "$R")" == "5042002" ]] || { echo "not a local arc-anvil"; exit 1; }
pk() { "$C" wallet private-key --mnemonic "$MN" --mnemonic-index "$1"; }
PK0=$(pk 0); PK2=$(pk 2); PK3=$(pk 3)
EN_OWNER=$("$C" wallet address --private-key "$PK0"); ZH_OWNER=$("$C" wallet address --private-key "$PK3")
FACTORY=$("$F" create src/ArcJarFactory.sol:ArcJarFactory --rpc-url "$R" --private-key "$PK0" --broadcast \
  --constructor-args 0xc7AC1469a8dc7E4df3CE2D646dd6D01296548CEd 20 2>&1 | awk '/Deployed to/{print $3}')
NOW=$("$C" block latest -f timestamp --rpc-url "$R")
TAXDAY=$(python3 -c "import datetime as d,time;y=time.gmtime().tm_year;t=d.datetime(y,4,15,tzinfo=d.timezone.utc).timestamp();print(int(t if t>time.time() else d.datetime(y+1,4,15,tzinfo=d.timezone.utc).timestamp()))")
SAVE=$((NOW + 30 * 86400)); Z=0x0000000000000000000000000000000000000000
b32() { python3 -c "import sys;b=sys.argv[1].encode();print('0x'+b.hex().ljust(64,'0'))" "$1"; }
seed() { # seed <owner_pk> <owner> <salt> <tax> <profit> <emergency>
  local salt jar; salt=$("$C" keccak "$3")
  jar=$("$C" call "$FACTORY" "predictJar(address,bytes32)(address)" "$2" "$salt" --rpc-url "$R")
  "$C" send -q --rpc-url "$R" --private-key "$1" "$FACTORY" "createJar(bytes32,(bytes32,uint16,uint64,address)[])" "$salt" \
    "[($(b32 "$4"),2500,$TAXDAY,$Z),($(b32 "$5"),500,0,$Z),($(b32 "$6"),1000,$SAVE,$Z)]"
  for amt in 1200 350 80; do "$C" send -q --rpc-url "$R" --private-key "$PK2" "$jar" --value "${amt}ether"; done
  # 45 USDC through the 6-decimal ERC-20 interface: arrives unsplit, waits for sweep()
  "$C" send -q --rpc-url "$R" --private-key "$PK2" 0x3600000000000000000000000000000000000000 "transfer(address,uint256)" "$jar" 45000000
  echo "$jar"
}
EN_JAR=$(seed "$PK0" "$EN_OWNER" demo-en Tax Profit "Emergency fund")
ZH_JAR=$(seed "$PK3" "$ZH_OWNER" demo-zh 税款 利润 应急金)
cat <<OUT
FACTORY=$FACTORY
EN_OWNER=$EN_OWNER EN_JAR=$EN_JAR
ZH_OWNER=$ZH_OWNER ZH_JAR=$ZH_JAR
Build:  VITE_FACTORY_LOCAL=$FACTORY npm --prefix app run build
Open:   app/dist/index.html?net=local&watch=$EN_OWNER
OUT
