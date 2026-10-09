#!/usr/bin/env python3
"""Read-only check against the REAL Arc testnet node (no funds, no transactions).

Copies the jar + implementation (code and storage) from a local arc-anvil fork into
`eth_call` / `eth_estimateGas` state overrides on https://rpc.testnet.arc.io, then asks
the real node:
  1. what gas a native USDC payment to a jar needs (wallet path), and that it succeeds;
  2. whether a fixed 21000-gas plain transfer (typical exchange withdrawal) succeeds.
Usage: scripts/verify_real_testnet.py deployments/e2e-arc-testnet-fork.json
"""
import json, sys, urllib.request

FORK = "http://127.0.0.1:8545"
REAL = "https://rpc.testnet.arc.io"

def rpc(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 {"content-type": "application/json", "user-agent": "arcjars-verify"})
    return json.load(urllib.request.urlopen(req, timeout=30))

def keccak_slot(slot):
    # keccak256(abi.encode(slot)) via the node's web3_sha3
    return rpc(FORK, "web3_sha3", ["0x" + format(slot, "064x")])["result"]

d = json.load(open(sys.argv[1]))
jar, impl, payer = d["jar"], d["implementation"], d["payer"]
n = int(rpc(FORK, "eth_getStorageAt", [jar, hex(3), "latest"])["result"], 16)
slots = [hex(i) for i in range(6)]
for arr in (3, 4, 5):  # _jars, _names, _dests
    base = int(keccak_slot(arr), 16)
    slots += [hex(base + i) for i in range(n)]
diff = {}
for s in slots:
    v = rpc(FORK, "eth_getStorageAt", [jar, s, "latest"])["result"]
    diff["0x" + format(int(s, 16), "064x")] = v
override = {
    jar: {"code": rpc(FORK, "eth_getCode", [jar, "latest"])["result"], "stateDiff": diff},
    impl: {"code": rpc(FORK, "eth_getCode", [impl, "latest"])["result"]},
    payer: {"balance": hex(100 * 10**18)},
}
call = {"from": payer, "to": jar, "value": hex(10**18)}
print("real node:", rpc(REAL, "web3_clientVersion", [])["result"], "chain", int(rpc(REAL, "eth_chainId", [])["result"], 16))
est = rpc(REAL, "eth_estimateGas", [call, "latest", override])
print("eth_estimateGas native 1 USDC payment ->", int(est["result"], 16) if "result" in est else est)
ok = rpc(REAL, "eth_call", [dict(call, gas=hex(int(est["result"], 16))), "latest", override])
print("eth_call with estimated gas ->", "success" if "result" in ok else ok.get("error"))
low = rpc(REAL, "eth_call", [dict(call, gas=hex(21000)), "latest", override])
print("eth_call with fixed 21000 gas ->", "success" if "result" in low else low.get("error"))

# 3. Does a USDC ERC-20 transfer() execute recipient code? Recipient = contract that always reverts.
reverter = "0x00000000000000000000000000000000000a4c00"
data = "0xa9059cbb" + reverter[2:].rjust(64, "0") + format(10**6, "064x")  # transfer(reverter, 1 USDC)
ov = {reverter: {"code": "0x60006000fd"}, payer: {"balance": hex(100 * 10**18)}}
r = rpc(REAL, "eth_call", [{"from": payer, "to": "0x3600000000000000000000000000000000000000", "data": data}, "latest", ov])
print("ERC-20 transfer to an always-reverting contract ->",
      "success (recipient code NOT executed -> sweep() needed)" if "result" in r else r.get("error"))
r = rpc(REAL, "eth_call", [{"from": payer, "to": reverter, "value": hex(10**18)}, "latest", ov])
print("native send to the same contract ->", "success" if "result" in r else f"reverts ({r['error']['message'][:60]}) -> code IS executed")
