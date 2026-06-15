/**
 * SERVER-ONLY config. NEVER import this from a "use client" component — the
 * relayer private key must never reach the browser. The Next.js API route
 * (app/api/gateway) and the deploy/setup scripts import this; the client only
 * talks to the gateway over HTTP.
 *
 * Values come from examples/.shared-env.local (loaded via dotenv) or process.env.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

function loadSharedEnv(): void {
  // examples/.shared-env.local lives two dirs up from examples/monopoly/lib.
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS / bundled fallback
    here = process.cwd();
  }
  const candidates = [
    resolve(here, "..", "..", ".shared-env.local"),
    resolve(process.cwd(), "..", ".shared-env.local"),
    resolve(process.cwd(), "examples", ".shared-env.local"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined || process.env[k] === "") {
        process.env[k] = v.replace(/^["']|["']$/g, "");
      }
    }
    break;
  }
}

loadSharedEnv();

/**
 * ⚠️ TESTNET ONLY — hardcoded so the example is self-contained and runnable out of
 * the box. Base Sepolia test key provided for the demo; holds only testnet
 * ETH/USDC. ROTATE before any mainnet use; never reuse for real funds.
 * Overridable via NEXUS_RELAYER_PRIVATE_KEY.
 */
export const HARDCODED_RELAYER_KEY =
  "0x18842c41d9c77a305c3e4c88d75d22c085d60a3e5e2452f5444633167a6dbaae";

export interface MonopolyServerConfig {
  relayerKey: `0x${string}`;
  relayerAddress: `0x${string}`;
  rpcUrl: string;
  usdc: `0x${string}`;
  chainId: number;
  explorer: string;
}

// ── UNO-style flat exports (server-only) used by lib/engine.ts + scripts ──
export const RELAYER_PRIVATE_KEY = (process.env.NEXUS_RELAYER_PRIVATE_KEY ||
  HARDCODED_RELAYER_KEY) as `0x${string}`;
export const RELAYER_ADDRESS = (process.env.NEXUS_RELAYER_ADDRESS ||
  "0xA3327d90d087cdddfB99E598E50B5Bdee7fC55bD") as `0x${string}`;
export const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** The buy-in (real USDC → Pot on Base Sepolia). Every in-game money transfer FROM a
 *  player (buy / rent / tax / build / fine / card debit) is settled as a real x402
 *  charge to the Pot at the $1 = 0.0001 USDC scale (see lib/board DOLLAR_TO_USDC), so
 *  charges are real but tiny. The pot pays the last solvent player on settle. */
export const ENTRY_FEE_USDC = process.env.ENTRY_FEE_USDC || "0.05";

// ── relayer rail selection ────────────────────────────────────────────────────
// `direct`  (default) — self-relay every redemption through the funded relayer key
//                       against the project's NexusDelegationManager (the demo path).
// `oneshot`           — route redemptions through the 1Shot Permissionless Public
//                       Relayer (gas paid in stablecoin). Toggle with MONOPOLY_RELAYER.
export type RelayerMode = "direct" | "oneshot";
export const RELAYER_MODE: RelayerMode =
  process.env.MONOPOLY_RELAYER === "oneshot" ? "oneshot" : "direct";

/** 1Shot public relayer JSON-RPC endpoint (Base mainnet host by default; pass the
 *  testnet host for Base-Sepolia infra). Only used when RELAYER_MODE === "oneshot". */
export const ONESHOT_ENDPOINT =
  process.env.ONESHOT_RELAYER_ENDPOINT || "https://relayer.1shotapi.com/relayers";
/** Optional bearer token for an authenticated 1Shot relayer instance (permissionless calls omit it). */
export const ONESHOT_BEARER = process.env.ONESHOT_RELAYER_BEARER || "";
/** Optional URL the relayer should POST status to (polling is the fallback). */
export const ONESHOT_DESTINATION_URL = process.env.ONESHOT_RELAYER_DESTINATION_URL || "";

export function serverConfig(): MonopolyServerConfig {
  const relayerKey = (process.env.NEXUS_RELAYER_PRIVATE_KEY || HARDCODED_RELAYER_KEY) as `0x${string}`;
  return {
    relayerKey,
    relayerAddress: (process.env.NEXUS_RELAYER_ADDRESS ||
      "0xA3327d90d087cdddfB99E598E50B5Bdee7fC55bD") as `0x${string}`,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    usdc: (process.env.USDC_ADDRESS ||
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
    chainId: 84532,
    explorer: "https://sepolia.basescan.org",
  };
}
