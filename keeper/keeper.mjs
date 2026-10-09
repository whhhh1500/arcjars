// ArcJars keeper: finds every jar created by the factory and calls sweep() on jars holding
// unallocated USDC (ERC-20 transfers and Memo payments don't run contract code on Arc).
// Optionally calls collectFees() once accrued fees pass a threshold.
//
// Env:  RPC_URL, FACTORY (required); KEEPER_PK (required unless DRY_RUN=1)
//       FROM_BLOCK (factory deploy block, default 0), INTERVAL_SEC (default 60), ONCE=1,
//       MIN_SWEEP_USDC (default 0.01), MIN_FEES_USDC (default 5; 0 disables), JARS (extra comma list)
import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi, formatEther, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const RPC_URL = env.RPC_URL ?? "https://rpc.testnet.arc.io";
const FACTORY = env.FACTORY && getAddress(env.FACTORY);
if (!FACTORY) throw new Error("FACTORY is required");
const DRY = env.DRY_RUN === "1";
const MIN_SWEEP = parseEther(env.MIN_SWEEP_USDC ?? "0.01");
const MIN_FEES = parseEther(env.MIN_FEES_USDC ?? "5");
const INTERVAL = Number(env.INTERVAL_SEC ?? 60) * 1000;
const CHUNK = 10_000n;
const MIN_FEE_PER_GAS = 20_000_000_000n; // Arc mempool drops anything under 20 gwei

const jarCreated = parseAbiItem("event JarCreated(address indexed owner, address indexed jar, bytes32 salt)");
const jarAbi = parseAbi([
  "function unallocated() view returns (uint256)",
  "function feesAccrued() view returns (uint256)",
  "function sweep()",
  "function collectFees()",
]);

const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = await pub.getChainId();
const chain = { id: chainId, name: `arc-${chainId}`, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const account = DRY ? null : privateKeyToAccount(env.KEEPER_PK ?? (() => { throw new Error("KEEPER_PK is required (or DRY_RUN=1)"); })());
const wallet = account && createWalletClient({ account, chain, transport: http(RPC_URL) });

const jars = new Set((env.JARS ?? "").split(",").filter(Boolean).map((a) => getAddress(a)));
let nextBlock = BigInt(env.FROM_BLOCK ?? 0);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function discover() {
  const head = await pub.getBlockNumber();
  while (nextBlock <= head) {
    const to = nextBlock + CHUNK - 1n > head ? head : nextBlock + CHUNK - 1n;
    const logs = await pub.getLogs({ address: FACTORY, event: jarCreated, fromBlock: nextBlock, toBlock: to });
    for (const l of logs) if (!jars.has(l.args.jar)) { jars.add(l.args.jar); log("discovered jar", l.args.jar); }
    nextBlock = to + 1n;
  }
}

async function fees() {
  const f = await pub.estimateFeesPerGas().catch(() => ({ maxFeePerGas: MIN_FEE_PER_GAS, maxPriorityFeePerGas: 1n }));
  const maxFeePerGas = f.maxFeePerGas < MIN_FEE_PER_GAS ? MIN_FEE_PER_GAS : f.maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 1n };
}

async function act(jar, fn, amount) {
  if (DRY) return log(`[dry-run] would ${fn}`, jar, formatEther(amount), "USDC");
  const { request } = await pub.simulateContract({ account, address: jar, abi: jarAbi, functionName: fn, ...(await fees()) });
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  log(fn, jar, formatEther(amount), "USDC", rc.status, hash);
}

async function tick() {
  await discover();
  for (const jar of jars) {
    try {
      const un = await pub.readContract({ address: jar, abi: jarAbi, functionName: "unallocated" });
      if (un >= MIN_SWEEP) await act(jar, "sweep", un);
      const fa = await pub.readContract({ address: jar, abi: jarAbi, functionName: "feesAccrued" });
      if (MIN_FEES > 0n && fa >= MIN_FEES) await act(jar, "collectFees", fa);
    } catch (e) {
      log("error", jar, e.shortMessage ?? e.message);
    }
  }
}

log(`keeper up: chain ${chainId}, factory ${FACTORY}, ${DRY ? "DRY RUN" : "keeper " + account.address}`);
do {
  try { await tick(); log(`tick ok: ${jars.size} jar(s) watched, scanned to block ${nextBlock - 1n}`); } catch (e) { log("tick failed:", e.shortMessage ?? e.message); }
  if (env.ONCE === "1") break;
  await new Promise((r) => setTimeout(r, INTERVAL));
} while (true);
