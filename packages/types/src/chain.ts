/**
 * Chain constants. Nexus is Base-only by design (see docs/roadmap conventions).
 * Base Sepolia is the default test target; Base mainnet is used only where a
 * feature is mainnet-only.
 */

export const CHAINS = {
  "base-sepolia": {
    id: 84532,
    name: "Base Sepolia",
    isTestnet: true,
    defaultRpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    // Canonical USDC on Base Sepolia (Circle).
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  base: {
    id: 8453,
    name: "Base",
    isTestnet: false,
    defaultRpcUrl: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    // Canonical native USDC on Base (Circle).
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
} as const;

export type ChainKey = keyof typeof CHAINS;

export function isChainKey(v: string): v is ChainKey {
  return v === "base" || v === "base-sepolia";
}

export function chainConfig(chain: ChainKey) {
  return CHAINS[chain];
}
