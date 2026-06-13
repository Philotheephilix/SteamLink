/** Run the zero-mock integration suite against a local anvil chain (no funding). */
import type { Address, Hex } from "@nexus/types";
import { ANVIL_ACCOUNTS, ANVIL_CHAIN_ID, ANVIL_RPC, startAnvil } from "../lib/anvil.js";
import { log } from "../lib/log.js";
import { type IntegrationTarget, runIntegration } from "./integration.js";

const localChain = {
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

async function main() {
  const { stop } = await startAnvil();
  let failures = 1;
  try {
    const target: IntegrationTarget = {
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
    };
    failures = await runIntegration(target);
  } finally {
    stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
