#!/usr/bin/env bash
# Deploy ArcJarFactory (+ ArcJar implementation) to Arc MAINNET.
#
#   DEPLOYER_PK=0x... ./scripts/deploy_mainnet.sh
#
# Needs: arc-forge/arc-cast (or forge/cast), python3, DEPLOYER_PK funded with ~1 USDC (deploy ≈ cents).
# Optional: VERIFY=1 (+ VERIFIER_URL) to verify source on the explorer; YES=1 to skip the prompt.
# Rehearsal (NOT mainnet): ARC_RPC_URL=http://127.0.0.1:8545 EXPECTED_CHAIN_ID=5042002 ...
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL=${ARC_RPC_URL:-https://rpc.mainnet.arc.io}
EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-5042}
export FEE_RECIPIENT=${FEE_RECIPIENT:-0xc7AC1469a8dc7E4df3CE2D646dd6D01296548CEd}
export FEE_BPS=${FEE_BPS:-20}
FORGE=${FORGE:-$(command -v arc-forge || command -v forge)}
CAST=${CAST:-$(command -v arc-cast || command -v cast)}
MIN_GAS_PRICE=20000000000 # Arc mempool silently drops txs with maxFeePerGas < 20 gwei

: "${DEPLOYER_PK:?set DEPLOYER_PK (hex private key of the funded deployer)}"
[[ -x "$FORGE" && -x "$CAST" ]] || { echo "forge/cast not found (install circlefin/arc-foundry)"; exit 1; }

CHAIN_ID=$("$CAST" chain-id --rpc-url "$RPC_URL")
[[ "$CHAIN_ID" == "$EXPECTED_CHAIN_ID" ]] || { echo "chain id $CHAIN_ID != expected $EXPECTED_CHAIN_ID; aborting"; exit 1; }
DEPLOYER=$("$CAST" wallet address --private-key "$DEPLOYER_PK")
BAL=$("$CAST" balance "$DEPLOYER" --rpc-url "$RPC_URL" --ether)
BASE=$("$CAST" base-fee --rpc-url "$RPC_URL")
GAS_PRICE=$(python3 -c "print(max(2*int('$BASE'), $MIN_GAS_PRICE) + 1_000_000_000)")

cat <<INFO
== ArcJars deploy ==
  rpc            $RPC_URL (chain $CHAIN_ID)
  deployer       $DEPLOYER  balance $BAL USDC
  feeRecipient   $FEE_RECIPIENT
  feeBps         $FEE_BPS  (0.2%, capped at 1 USDC per payment)
  maxFeePerGas   $GAS_PRICE wei (base fee $BASE)
INFO
python3 -c "import sys; sys.exit(0 if float('$BAL') >= 0.05 else 1)" || { echo "deployer balance too low"; exit 1; }
if [[ "${YES:-0}" != "1" ]]; then
  read -r -p "Type DEPLOY to broadcast: " ans; [[ "$ans" == "DEPLOY" ]] || { echo "aborted"; exit 1; }
fi

VERIFY_ARGS=()
if [[ "${VERIFY:-0}" == "1" ]]; then
  VERIFY_ARGS=(--verify --verifier blockscout --verifier-url "${VERIFIER_URL:-https://explorer.arc.io/api/}")
fi

cd contracts
"$FORGE" build --quiet
"$FORGE" script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" \
  --broadcast --slow \
  --with-gas-price "$GAS_PRICE" --priority-gas-price 1000000000 \
  "${VERIFY_ARGS[@]}"
cd ..

RUN="contracts/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
NAME=$([[ "$CHAIN_ID" == "5042" ]] && echo arc-mainnet || echo "rehearsal-$CHAIN_ID")
python3 - "$RUN" "$CHAIN_ID" "$RPC_URL" "deployments/$NAME.json" <<'PY'
import json, sys
run, chain, rpc, out = sys.argv[1:]
d = json.load(open(run))
tx = next(t for t in d["transactions"] if t.get("contractName") == "ArcJarFactory")
rc = next(r for r in d["receipts"] if r["transactionHash"] == tx["hash"])
impl = next((c["address"] for c in tx.get("additionalContracts", [])), None)
res = {"chainId": int(chain), "rpc": rpc, "factory": tx["contractAddress"], "implementation": impl,
       "deployTx": tx["hash"], "block": int(rc["blockNumber"], 16), "status": rc["status"]}
json.dump(res, open(out, "w"), indent=2)
print(json.dumps(res, indent=2))
print(f"\nNext: build the app with  VITE_FACTORY_ARC={res['factory']} npm --prefix app run build")
print(f"      run the keeper with   RPC_URL={rpc} FACTORY={res['factory']} FROM_BLOCK={res['block']} KEEPER_PK=... node keeper/keeper.mjs")
PY

# Post-deploy sanity: read the immutables back from chain and refuse to continue silently if they differ.
OUTJSON="deployments/$NAME.json"
IMPL=$(python3 -c "import json;print(json.load(open('$OUTJSON'))['implementation'])")
GOT_FR=$("$CAST" call "$IMPL" "feeRecipient()(address)" --rpc-url "$RPC_URL")
GOT_BPS=$("$CAST" call "$IMPL" "feeBps()(uint16)" --rpc-url "$RPC_URL")
GOT_OWNER=$("$CAST" call "$IMPL" "owner()(address)" --rpc-url "$RPC_URL")
echo "on-chain check: feeRecipient $GOT_FR  feeBps $GOT_BPS  implementation owner $GOT_OWNER"
[[ "${GOT_FR,,}" == "${FEE_RECIPIENT,,}" && "$GOT_BPS" == "$FEE_BPS" && "${GOT_OWNER,,}" == "0x000000000000000000000000000000000000dead" ]] \
  || { echo "!! on-chain values do not match the intended config"; exit 1; }
echo "OK"
