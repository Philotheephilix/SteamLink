/**
 * LIVE preflight. Verifies the environment is ready to run the zero-mock test
 * suite against a real chain: RPC reachable, chain id correct, deployer funded
 * with gas, USDC balance reported, optional second player + 1Shot detected.
 *
 * Run: pnpm --filter @nexus/scripts preflight
 * (after copying .env.example to .env and setting PRIVATE_KEY)
 */
import { erc20Abi, formatEther, formatUnits } from "viem";
import { loadEnv, publicClientFor } from "./lib/env.js";
import { log } from "./lib/log.js";

async function main() {
  log.title("Nexus live preflight");

  const env = loadEnv();
  const pub = publicClientFor(env);

  log.step(`Chain: ${env.chain.name} (${env.chainKey})`);
  log.info(`RPC: ${env.rpcUrl}`);
  log.info(`Explorer: ${env.explorer}`);

  // 1. RPC reachable + correct chain id (real network round-trip).
  const chainId = await pub.getChainId();
  if (chainId !== env.chain.id) {
    log.fail(`RPC chain id ${chainId} != expected ${env.chain.id}`);
    process.exit(1);
  }
  log.ok(`RPC reachable, chain id ${chainId}`);

  // 2. Deployer/player-1 gas balance.
  log.step(`Primary account: ${env.account.address}`);
  const bal = await pub.getBalance({ address: env.account.address });
  log.info(`ETH balance: ${formatEther(bal)}`);
  if (bal === 0n) {
    log.fail("Primary account has 0 ETH — fund it for gas before running live tests.");
    if (env.chainKey === "base-sepolia") {
      log.info("Base Sepolia faucet: https://docs.base.org/tools/network-faucets");
    }
    process.exit(1);
  }
  log.ok("Primary account funded for gas");

  // 3. USDC balance (needed for entry-fee / x402 charge tests).
  try {
    const usdc = await pub.readContract({
      address: env.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [env.account.address],
    });
    const dec = await pub.readContract({
      address: env.usdc,
      abi: erc20Abi,
      functionName: "decimals",
    });
    log.info(`USDC (${env.usdc}): ${formatUnits(usdc, dec)}`);
    if (usdc === 0n) {
      log.warn("0 USDC — payment/x402 tests will be skipped until funded.");
    } else {
      log.ok("USDC present — monetization tests can run");
    }
  } catch {
    log.warn("Could not read USDC balance (token may differ on this RPC).");
  }

  // 4. Optional second player.
  if (env.account2) {
    const bal2 = await pub.getBalance({ address: env.account2.address });
    log.ok(`Second player ${env.account2.address} (${formatEther(bal2)} ETH)`);
    if (bal2 === 0n) log.warn("Second player has 0 ETH — multi-player move tests need gas.");
  } else {
    log.warn("No PRIVATE_KEY_2 — multi-player paths run single-player only.");
  }

  // 5. Deployed contracts.
  log.step("Deployed contracts");
  log.info(`WORLD_ADDRESS: ${env.worldAddress ?? "(not deployed yet — run scripts/deploy)"}`);
  log.info(`DELEGATION_MANAGER: ${env.delegationManager ?? "(set canonical MetaMask address)"}`);

  // 6. Relayer path.
  log.step("Relayer");
  if (env.oneShot) log.ok("1Shot credentials present — OneShotRelayer available");
  else log.info("No 1Shot creds — using live DirectRelayer (self-relay). Not a mock.");

  log.title("Preflight complete — environment is live-ready");
}

main().catch((err) => {
  log.fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
