/**
 * Orchestrator for the live test suite.
 *
 *  - Always runs the suite against a local anvil chain (the zero-funding proof).
 *  - If a funded key is configured in .env (PRIVATE_KEY with gas on the target
 *    chain), ALSO runs the identical suite against Base Sepolia / Base — the real
 *    target. The player is a freshly generated key that only signs (never funded).
 *
 * Run: pnpm --filter @nexus/scripts live
 */
import type { Address, Hex } from "@nexus/types";
import { http, createPublicClient, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ANVIL_ACCOUNTS, ANVIL_CHAIN_ID, ANVIL_RPC, startAnvil } from "../lib/anvil.js";
import { loadEnv } from "../lib/env.js";
import { log } from "../lib/log.js";
import { type IntegrationTarget, runIntegration } from "./integration.js";

const localChain = {
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

async function runLocal(): Promise<number> {
  const { stop } = await startAnvil();
  try {
    return await runIntegration({
      label: "local anvil",
      chain: localChain,
      rpcUrl: ANVIL_RPC,
      chainId: ANVIL_CHAIN_ID,
      relayer: {
        key: ANVIL_ACCOUNTS.deployer.key as Hex,
        address: ANVIL_ACCOUNTS.deployer.address as Address,
      },
      player: {
        key: ANVIL_ACCOUNTS.player.key as Hex,
        address: ANVIL_ACCOUNTS.player.address as Address,
      },
      player2: {
        key: ANVIL_ACCOUNTS.player2.key as Hex,
        address: ANVIL_ACCOUNTS.player2.address as Address,
      },
    });
  } finally {
    stop();
  }
}

async function runOnChain(): Promise<number | "skipped"> {
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch {
    return "skipped";
  }
  const pub = createPublicClient({ chain: env.chain, transport: http(env.rpcUrl) });
  const bal = await pub.getBalance({ address: env.account.address });
  if (bal === 0n) {
    log.warn(
      `On-chain run skipped: relayer ${env.account.address} has 0 ETH on ${env.chain.name}. Fund it to run the live ${env.chain.name} suite.`,
    );
    return "skipped";
  }
  log.info(
    `Relayer ${env.account.address} funded with ${formatEther(bal)} ETH on ${env.chain.name}`,
  );

  // The players only sign — generate throwaway keys (need no funds).
  const playerKey = generatePrivateKey();
  const player = privateKeyToAccount(playerKey);
  const player2Key = generatePrivateKey();
  const player2 = privateKeyToAccount(player2Key);
  const target: IntegrationTarget = {
    label: env.chain.name,
    chain: env.chain,
    rpcUrl: env.rpcUrl,
    chainId: env.chain.id,
    relayer: { key: env.privateKey as Hex, address: env.account.address as Address },
    player: { key: playerKey as Hex, address: player.address as Address },
    player2: { key: player2Key as Hex, address: player2.address as Address },
  };
  return runIntegration(target);
}

async function main() {
  log.title("Nexus live suite");
  const localFailures = await runLocal();

  const onchain = await runOnChain();
  const onchainFailures = onchain === "skipped" ? 0 : onchain;
  if (onchain === "skipped") log.info("(Base Sepolia run not executed — see message above.)");

  const total = localFailures + onchainFailures;
  log.title(total === 0 ? "LIVE SUITE GREEN" : `LIVE SUITE: ${total} failure(s)`);
  process.exit(total === 0 ? 0 : 1);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
