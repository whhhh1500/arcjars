import { defineChain, type Address, type Chain } from "viem";

export const USDC_ERC20: Address = "0x3600000000000000000000000000000000000000";
export const MEMO: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

const usdc = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
  testnet: true,
});

export const arcLocal = defineChain({
  ...arcTestnet,
  name: "Arc Testnet (local fork)",
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export interface Network {
  key: "arc" | "arc-testnet" | "local";
  chain: Chain;
  /** ArcJarFactory address. Filled in after deployment (see README "Deploy"). */
  factory: Address | "";
}

// Set the factory addresses here (or with VITE_FACTORY_ARC / VITE_FACTORY_ARC_TESTNET at build time).
export const NETWORKS: Network[] = [
  { key: "arc", chain: arcMainnet, factory: (import.meta.env.VITE_FACTORY_ARC ?? "") as Address | "" },
  { key: "arc-testnet", chain: arcTestnet, factory: (import.meta.env.VITE_FACTORY_ARC_TESTNET ?? "") as Address | "" },
  { key: "local", chain: arcLocal, factory: "" },
];

/** URL params: ?net=arc|arc-testnet|local  &factory=0x..  &rpc=http://..  &watch=0xOwner */
export function resolveNetwork(params: URLSearchParams): Network {
  const key = params.get("net") ?? "arc";
  const base = NETWORKS.find((n) => n.key === key) ?? NETWORKS[0];
  const factory = (params.get("factory") as Address | null) ?? base.factory;
  const rpc = params.get("rpc");
  const chain = rpc ? defineChain({ ...base.chain, rpcUrls: { default: { http: [rpc] } } }) : base.chain;
  return { ...base, chain, factory };
}

export const explorerAddr = (n: Network, a: string) => `${n.chain.blockExplorers?.default.url}/address/${a}`;
export const explorerTx = (n: Network, h: string) => `${n.chain.blockExplorers?.default.url}/tx/${h}`;
