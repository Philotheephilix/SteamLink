import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeploymentAddresses } from "@nexus/core";
import type { Address, Hex } from "@nexus/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(__dirname, "..", "..", "packages", "contracts");
const FORGE = `${process.env.HOME}/.foundry/bin/forge`;

export interface DeployedNexus extends DeploymentAddresses {
  counterGame: Address;
  counterGameSystemId: Hex;
  roomId: bigint;
  /** LOCAL-only TestUSDC (6 decimals) — the budget token for charge tests on anvil. */
  testUsdc: Address;
  /** The Pot deployed for the charge tests — the allowed charge recipient. */
  pot: Address;
}

export interface DeployParams {
  rpcUrl: string;
  deployerKey: Hex;
  player: Address;
  player2?: Address;
  roomId?: bigint;
  chainId: number;
}

/**
 * Deploy the full Nexus stack via the Foundry DeployFull script and return the
 * addresses it wrote to packages/contracts/deployments/<chainId>.json. This runs
 * REAL on-chain deployments against whatever RPC is given (local anvil or Base).
 */
export function deployNexus(p: DeployParams): DeployedNexus {
  execFileSync(
    FORGE,
    [
      "script",
      "script/DeployFull.s.sol:DeployFull",
      "--rpc-url",
      p.rpcUrl,
      "--private-key",
      p.deployerKey,
      "--broadcast",
      "--skip-simulation",
    ],
    {
      cwd: CONTRACTS,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`,
        PLAYER: p.player,
        ...(p.player2 ? { PLAYER2: p.player2 } : {}),
        ROOM_ID: String(p.roomId ?? 1n),
      },
    },
  );

  const path = resolve(CONTRACTS, "deployments", `${p.chainId}.json`);
  if (!existsSync(path)) throw new Error(`deployment json not found at ${path}`);
  const j = JSON.parse(readFileSync(path, "utf8"));

  return {
    world: j.world,
    delegationManager: j.delegationManager,
    turnManager: j.turnManager,
    counterGame: j.counterGame,
    counterGameSystemId: j.counterGameSystemId,
    roomId: BigInt(j.roomId),
    testUsdc: j.testUsdc,
    pot: j.pot,
    usdc: "0x0000000000000000000000000000000000000000", // not used by the counter game
    enforcers: {
      turnBound: j.enforcers.turnBound,
      systemAllowlist: j.enforcers.systemAllowlist,
      timestamp: j.enforcers.timestamp,
      limitedCalls: j.enforcers.limitedCalls,
      perActionCap: j.enforcers.perActionCap,
      erc20TransferAmount: j.enforcers.erc20TransferAmount,
      allowedRecipients: j.enforcers.allowedRecipients,
    },
  };
}
