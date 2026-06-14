/**
 * SERVER-ONLY: generate + fund the UNO player keys (1 human + N bots), idempotently.
 *
 * This is the reusable core extracted from scripts/fund-players.ts so it can be
 * called in-process by lib/auto-start.ts (no child process). For each player the
 * relayer sends ETH + USDC top-ups (only when below threshold), then the player
 * sends its OWN approve(manager) so the relayer can redeem the budget delegation.
 *
 * Writes examples/uno/players.local.json (gitignored). NEVER import from a client
 * component (it reads the relayer key).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { http, createPublicClient, createWalletClient, formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "@nexus/types";
import { usdcToWei } from "@nexus/core";
import { BASE_SEPOLIA_RPC_URL, RELAYER_PRIVATE_KEY } from "./config";
import { deployment } from "./deployment";
import { baseSepolia, USDC_ABI } from "./engine";

export interface PlayerKey {
  role: "human" | "bot";
  index: number;
  privateKey: Hex;
  address: Address;
}

export interface EnsurePlayersOptions {
  botCount?: number;
  usdcEach?: string;
  ethEach?: string;
  /** Regenerate keys even if players.local.json exists. */
  fresh?: boolean;
}

const PLAYERS_PATH = join(import.meta.dirname, "..", "players.local.json");

export function playersFilePath(): string {
  return PLAYERS_PATH;
}

/** Read players.local.json if present (no funding). */
export function readPlayers(): PlayerKey[] | null {
  if (!existsSync(PLAYERS_PATH)) return null;
  try {
    return (JSON.parse(readFileSync(PLAYERS_PATH, "utf8")) as { players: PlayerKey[] }).players;
  } catch {
    return null;
  }
}

/**
 * Ensure 1 human + N bots exist, are funded (ETH + USDC), and have approved the
 * delegation manager. Idempotent: reuses existing keys + only tops up below the
 * threshold. Returns the player keys and writes players.local.json.
 */
export async function ensurePlayers(opts: EnsurePlayersOptions = {}): Promise<PlayerKey[]> {
  const botCount = opts.botCount ?? Number(process.env.BOT_COUNT ?? 2);
  const usdcEach = opts.usdcEach ?? process.env.USDC_EACH ?? "0.5";
  const ethEach = opts.ethEach ?? process.env.ETH_EACH ?? "0.0009";
  const fresh = opts.fresh ?? process.env.FRESH === "1";

  const relayer = privateKeyToAccount(RELAYER_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) });
  const relayerWallet = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) });

  let players: PlayerKey[];
  const existing = readPlayers();
  if (existing && !fresh) {
    players = existing;
    console.log(`[ensure-players] reusing ${players.length} existing player key(s)`);
  } else {
    players = [];
    const humanKey = generatePrivateKey();
    players.push({ role: "human", index: 0, privateKey: humanKey, address: privateKeyToAccount(humanKey).address });
    for (let i = 0; i < botCount; i++) {
      const k = generatePrivateKey();
      players.push({ role: "bot", index: i, privateKey: k, address: privateKeyToAccount(k).address });
    }
    console.log(`[ensure-players] generated 1 human + ${botCount} bot key(s)`);
  }

  console.log(`[ensure-players] relayer ${relayer.address}`);
  const relEth = await publicClient.getBalance({ address: relayer.address });
  console.log(`[ensure-players] relayer ETH ${formatEther(relEth)}`);

  // Fund each player SEQUENTIALLY (await receipts → no relayer nonce collisions).
  for (const p of players) {
    console.log(`[ensure-players] ${p.role}#${p.index} ${p.address}`);

    // 1) ETH top-up.
    const haveEth = await publicClient.getBalance({ address: p.address });
    if (haveEth < parseEther(ethEach)) {
      const ethHash = await relayerWallet.sendTransaction({ account: relayer, chain: baseSepolia, to: p.address, value: parseEther(ethEach) });
      await publicClient.waitForTransactionReceipt({ hash: ethHash });
      console.log(`  ETH +${ethEach} tx ${ethHash}`);
    } else {
      console.log(`  ETH ok (${formatEther(haveEth)})`);
    }

    // 2) USDC top-up.
    const haveUsdc = (await publicClient.readContract({
      address: deployment.usdc,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [p.address],
    })) as bigint;
    if (haveUsdc < usdcToWei(usdcEach)) {
      const usdcHash = await relayerWallet.writeContract({
        address: deployment.usdc,
        abi: [
          { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
        ],
        functionName: "transfer",
        args: [p.address, usdcToWei(usdcEach)],
        account: relayer,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: usdcHash });
      console.log(`  USDC +${usdcEach} tx ${usdcHash}`);
    } else {
      console.log(`  USDC ok (${Number(haveUsdc) / 1e6})`);
    }

    // 3) Player approves the manager to spend its USDC (the player's OWN tx).
    const account = privateKeyToAccount(p.privateKey);
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) });
    const allowance = (await publicClient.readContract({
      address: deployment.usdc,
      abi: USDC_ABI,
      functionName: "allowance",
      args: [p.address, deployment.delegationManager],
    })) as bigint;
    if (allowance < usdcToWei(usdcEach)) {
      const apHash = await wallet.writeContract({
        address: deployment.usdc,
        abi: USDC_ABI,
        functionName: "approve",
        args: [deployment.delegationManager, usdcToWei("1000")],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: apHash });
      console.log(`  approve(manager) tx ${apHash}`);
    } else {
      console.log(`  approve ok`);
    }
  }

  writeFileSync(PLAYERS_PATH, JSON.stringify({ players }, null, 2));
  console.log(`[ensure-players] wrote ${PLAYERS_PATH}`);
  return players;
}
