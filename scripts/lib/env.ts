import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { CHAINS, type ChainKey, isChainKey } from "@nexus/types";
import { type Chain, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// Load .env from repo root (real secrets; never committed).
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

export interface NexusEnv {
  chainKey: ChainKey;
  chain: Chain;
  rpcUrl: string;
  usdc: `0x${string}`;
  explorer: string;
  /** primary funded account (deployer + player 1) */
  account: ReturnType<typeof privateKeyToAccount>;
  /** optional second player */
  account2?: ReturnType<typeof privateKeyToAccount>;
  worldAddress?: `0x${string}`;
  delegationManager?: `0x${string}`;
  oneShot?: { apiKey: string; apiSecret: string; endpoint: string; webhookUrl?: string };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.includes("...")) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function optionalKey(name: string): `0x${string}` | undefined {
  const v = process.env[name]?.trim();
  if (!v || v.includes("...")) return undefined;
  return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
}

export function loadEnv(): NexusEnv {
  const chainKey = (process.env.CHAIN ?? "base-sepolia").trim();
  if (!isChainKey(chainKey)) {
    throw new Error(`CHAIN must be "base" or "base-sepolia", got "${chainKey}"`);
  }
  const cfg = CHAINS[chainKey];
  const chain = chainKey === "base" ? base : baseSepolia;
  const rpcUrl =
    (chainKey === "base" ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL)?.trim() ||
    cfg.defaultRpcUrl;

  const pk = optionalKey("PRIVATE_KEY") ?? (need("PRIVATE_KEY") as `0x${string}`);
  const account = privateKeyToAccount(pk);
  const pk2 = optionalKey("PRIVATE_KEY_2");
  const account2 = pk2 ? privateKeyToAccount(pk2) : undefined;

  const oneShotKey = process.env.ONESHOT_API_KEY?.trim();
  const oneShot =
    oneShotKey && !oneShotKey.includes("...")
      ? {
          apiKey: oneShotKey,
          apiSecret: need("ONESHOT_API_SECRET"),
          endpoint: process.env.ONESHOT_ENDPOINT?.trim() || "https://relayer.1shotapi.com",
          webhookUrl: process.env.ONESHOT_WEBHOOK_URL?.trim() || undefined,
        }
      : undefined;

  return {
    chainKey,
    chain,
    rpcUrl,
    usdc: cfg.usdc as `0x${string}`,
    explorer: cfg.explorer,
    account,
    account2,
    worldAddress: optionalKey("WORLD_ADDRESS"),
    delegationManager: optionalKey("DELEGATION_MANAGER_ADDRESS"),
    oneShot,
  };
}

export function publicClientFor(env: NexusEnv) {
  return createPublicClient({ chain: env.chain, transport: http(env.rpcUrl) });
}

export function walletClientFor(env: NexusEnv, which: "account" | "account2" = "account") {
  const acct = which === "account2" ? env.account2 : env.account;
  if (!acct) throw new Error(`No ${which} configured (set PRIVATE_KEY_2 for a second player)`);
  return createWalletClient({ account: acct, chain: env.chain, transport: http(env.rpcUrl) });
}
