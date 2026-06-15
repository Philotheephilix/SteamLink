/**
 * SERVER-ONLY — the low-level Nexus redemption engine for Monopoly, driving a REAL
 * multiplayer game to a win with distinct per-player keys (mirrors examples/uno).
 *
 * Each player signs their OWN delegations (gameplay + budget) with their OWN key;
 * the relayer (the single funded key, server-side) redeems them via the
 * NexusDelegationManager:
 *   - gameplay delegation  → gasless dice rolls (turn-bound rollAndMove)
 *   - budget delegation    → real x402 USDC charges (buy-in / property buy / rent),
 *                            each a transferFrom(player -> Pot) bounded on-chain by
 *                            the player's spend caps + recipient allowlist.
 * No player ever pays gas. recordBuy / recordRent (ownership + play-cash ledger),
 * room seating, openPot and the final settle are admin/authority ops driven by the
 * relayer directly (it is the TurnManager admin, the game admin, and the Pot
 * settle authority). ALL relayer submissions are serialized so the single key's
 * nonces never collide.
 */
import {
  type DeploymentAddresses,
  type SignedDelegation,
  buildChargeFromExecution,
  buildMoveExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  usdcToWei,
} from "@steamlink/core";
import { revertDataOf } from "@steamlink/relayer";
import type { Address, Hex } from "@steamlink/types";
import { OneShotPublicRelayer } from "./oneshot-relayer";
import {
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
} from "viem";
import { type LocalAccount, privateKeyToAccount } from "viem/accounts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  ONESHOT_BEARER,
  ONESHOT_DESTINATION_URL,
  ONESHOT_ENDPOINT,
  RELAYER_MODE,
  RELAYER_PRIVATE_KEY,
} from "./config";
import { addresses, deployment, MONOPOLY_SYSTEM_ID } from "./deployment";

export const baseSepolia = {
  id: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_SEPOLIA_RPC_URL] } },
} as const satisfies Chain;

// ── ABIs ────────────────────────────────────────────────────────────────────

export const MONOPOLY_ABI = [
  {
    type: "function",
    name: "rollAndMove",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [
      { name: "die1", type: "uint8" },
      { name: "die2", type: "uint8" },
      { name: "newPos", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "joinGame",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordBuy",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "spaceId", type: "uint256" },
      { name: "player", type: "address" },
      { name: "price", type: "uint256" },
      { name: "rent", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordRent",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "spaceId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordAction",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "action", type: "bytes32" },
      { name: "spaceId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "endTurn",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordOwner",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "spaceId", type: "uint256" },
      { name: "owner", type: "address" },
      { name: "price", type: "uint256" },
      { name: "rent", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setCash",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
      { name: "cash", type: "uint256" },
      { name: "position", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordBankrupt",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cashOf",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "spaceId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Monopoly_Rolled",
    inputs: [
      { name: "roomId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "die1", type: "uint8", indexed: false },
      { name: "die2", type: "uint8", indexed: false },
      { name: "fromPos", type: "uint256", indexed: false },
      { name: "toPos", type: "uint256", indexed: false },
      { name: "passedGo", type: "bool", indexed: false },
    ],
  },
] as const;

export const TURN_MANAGER_ABI = [
  {
    type: "function",
    name: "startTurns",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "order", type: "address[]" },
      { name: "turnBlocks", type: "uint64" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "getCurrent", inputs: [{ name: "roomId", type: "uint256" }], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "advance", inputs: [{ name: "roomId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
] as const;

export const POT_ABI = [
  { type: "function", name: "openPot", inputs: [{ name: "roomId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "creditDeposit",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const USDC_ABI = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

// ── engine ──────────────────────────────────────────────────────────────────

export interface MonopolyEngine {
  publicClient: PublicClient;
  /** Retry-wrapped relayer wallet (fresh nonce + gas bump + receipt-resubmit on every send). */
  relayerWallet: RelayerWallet;
  relayer: LocalAccount;
  addrs: DeploymentAddresses;
  /** Present only when MONOPOLY_RELAYER=oneshot — the 1Shot public-relayer rail. */
  oneshot?: OneShotPublicRelayer;
}

let cached: Promise<MonopolyEngine> | null = null;
export function getEngine(): Promise<MonopolyEngine> {
  if (!cached) cached = boot();
  return cached;
}

async function boot(): Promise<MonopolyEngine> {
  const relayer = privateKeyToAccount(RELAYER_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) }) as PublicClient;
  const rawWallet = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) });
  const relayerWallet = wrapRetryingWallet(rawWallet, publicClient, relayer);

  let oneshot: OneShotPublicRelayer | undefined;
  if (RELAYER_MODE === "oneshot") {
    oneshot = new OneShotPublicRelayer({
      endpoint: ONESHOT_ENDPOINT,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      bearerToken: ONESHOT_BEARER || undefined,
      destinationUrl: ONESHOT_DESTINATION_URL || undefined,
    });
    // Startup guard: a 7710 redemption only settles if the player delegation's
    // `delegate` equals the relayer's targetAddress. Surface a mismatch at boot
    // (the demo's delegations are signed for RELAYER_ADDRESS) instead of as a
    // silent on-chain revert later. Non-fatal — log and continue.
    void oneshot
      .getCapabilities()
      .then((caps) => {
        if (caps.targetAddress.toLowerCase() !== relayer.address.toLowerCase()) {
          console.warn(
            `[monopoly] MONOPOLY_RELAYER=oneshot: 1Shot targetAddress ${caps.targetAddress} != delegation delegate ${relayer.address}. ` +
              "Redemptions will revert unless player delegations are signed for the 1Shot target.",
          );
        } else {
          console.info(`[monopoly] 1Shot relayer rail active (target ${caps.targetAddress}).`);
        }
      })
      .catch((e) => console.warn(`[monopoly] 1Shot capabilities probe failed: ${(e as Error).message}`));
  }

  return { publicClient, relayerWallet, relayer, addrs: addresses, oneshot };
}

// Per-player delegation signing (each player signs with its OWN key) lives in the
// browser-safe ./delegations module; re-export for server-side callers.
export { signGameplayDelegation, signBudgetDelegation } from "./delegations";

// ── retry / submit helpers ────────────────────────────────────────────────────

/** A revert (named custom error / "execution reverted") is a DETERMINISTIC failure
 *  (e.g. the turn-bound enforcer rejecting a stale roll) — retrying won't help. Only
 *  retry genuinely transient RPC/network errors. */
function isOnChainRevert(e: unknown): boolean {
  const data = revertDataOf(e) ?? revertDataOf((e as { cause?: unknown })?.cause);
  return data !== undefined || /execution reverted|reverted on-chain/i.test(String(e));
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4, retryOnRevert = true): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const revert = isOnChainRevert(e);
      if ((revert && !retryOnRevert) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Flatten an error (message + details + nested cause chain) for classification. */
function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    parts.push(String(o.shortMessage ?? ""), String(o.details ?? ""), String(o.message ?? ""));
    cur = o.cause;
  }
  return parts.join(" ");
}

/** Classify a relayer-submission error (shared-key contention / flaky RPC vs a real revert). */
function retryClass(e: unknown): "nonce" | "underpriced" | "rpc" | "revert" | "fatal" {
  const m = errText(e);
  if (/replacement transaction underpriced|transaction underpriced|fee too low|max fee per gas less than|priority fee/i.test(m))
    return "underpriced";
  if (/nonce too low|nonce too high|invalid nonce|already known|already imported|nonce has already been used|replacement/i.test(m))
    return "nonce";
  if (/missing or invalid parameters|timeout|timed out|fetch failed|socket|other side closed|ECONNRESET|ETIMEDOUT|service unavailable|bad gateway|rate limit|429|502|503|504|invalid json|could not be found|header not found|block is out of range/i.test(m))
    return "rpc";
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(m)) return "fatal";
  if (isOnChainRevert(e)) return "revert";
  return "rpc";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry-wrapped relayer wallet (same robustness as the UNO example). Serializes
 * sends (process-wide mutex), fetches a FRESH pending nonce + BUMPS priority fee
 * per attempt (wins replacement races), backs off with jitter on
 * underpriced/nonce/RPC errors, and additionally RE-SUBMITS if a sent tx's
 * receipt isn't seen within 45s (cross-process nonce eviction). `fatal` never
 * retries; reverts get a few attempts (read-after-write lag) then surface.
 */
type RelayerWallet = {
  writeContract: (args: Record<string, unknown>) => Promise<Hex>;
  sendTransaction: (args: Record<string, unknown>) => Promise<Hex>;
  account: ReturnType<typeof privateKeyToAccount>;
};

function wrapRetryingWallet(
  wallet: { writeContract: (a: never) => Promise<Hex>; sendTransaction: (a: never) => Promise<Hex> },
  publicClient: PublicClient,
  account: ReturnType<typeof privateKeyToAccount>,
): RelayerWallet {
  let chain: Promise<unknown> = Promise.resolve();
  const MAX = 12;

  async function attempt(kind: "write" | "send", args: Record<string, unknown>): Promise<Hex> {
    let last: unknown;
    for (let i = 0; i < MAX; i++) {
      try {
        const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
        const fees = await publicClient.estimateFeesPerGas().catch(() => ({}) as Record<string, bigint>);
        const bump = (v?: bigint) => (v ? (v * BigInt(100 + 25 * i)) / 100n : undefined);
        const gas =
          fees.maxFeePerGas !== undefined
            ? { maxFeePerGas: bump(fees.maxFeePerGas), maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas ?? fees.maxFeePerGas) }
            : {};
        const full = { ...args, nonce, ...gas } as never;
        const hash = kind === "write" ? await wallet.writeContract(full) : await wallet.sendTransaction(full);
        // Re-submit if the receipt isn't seen in 45s (the tx was likely evicted by a
        // same-nonce tx from another process sharing this key).
        const r = await Promise.race([
          publicClient.waitForTransactionReceipt({ hash }).then((x) => x),
          sleep(45_000).then(() => null),
        ]);
        if (r) return hash; // mined (success or revert — caller's receipt check handles status)
      } catch (e) {
        last = e;
        const cls = retryClass(e);
        if (cls === "fatal" || (cls === "revert" && i >= 4) || i >= MAX - 1) throw e;
      }
      const base = 2000;
      await sleep(base + i * 1000 + Math.floor(Math.random() * 900));
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  const run = (kind: "write" | "send", args: Record<string, unknown>): Promise<Hex> => {
    const p = chain.then(() => attempt(kind, args));
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  return { account, writeContract: (a) => run("write", a), sendTransaction: (a) => run("send", a) };
}

type SubmitResult = { txHash: Hex; blockNumber: bigint; logs: { address: string; topics: readonly Hex[]; data: Hex }[] };

/**
 * Submit a single player-delegation redemption through the configured rail and
 * confirm it on-chain. Both rails resolve to the same shape (txHash + the
 * receipt's block + logs), so callers (roll/charge/action/endTurn) are rail-agnostic.
 *
 *   - direct  (default): build `manager.redeemDelegations(...)` calldata and
 *                        self-relay it via the funded relayer key.
 *   - oneshot: hand the structured delegation + execution to the 1Shot public
 *              relayer (gas in stablecoin), then read the receipt for block + logs.
 */
async function submitRedemption(e: MonopolyEngine, signed: SignedDelegation, exec: Hex): Promise<SubmitResult> {
  if (e.oneshot) {
    const { txHash } = await e.oneshot.redeem(signed, exec);
    const receipt = await e.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`1Shot redemption reverted on-chain (tx ${txHash})`);
    return {
      txHash,
      blockNumber: receipt.blockNumber,
      logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data })),
    };
  }

  const data = buildRedeemCalldata(encodePermissionContext(signed), exec);
  const hash = (await e.relayerWallet.sendTransaction({
    account: e.relayer,
    chain: baseSepolia,
    to: e.addrs.delegationManager,
    data,
  })) as Hex;
  const receipt = await e.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`redemption reverted on-chain (tx ${hash})`);
  return {
    txHash: hash,
    blockNumber: receipt.blockNumber,
    logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data })),
  };
}

export interface RollResult {
  status: "mined";
  txHash: Hex;
  blockNumber: bigint;
  die1: number;
  die2: number;
  fromPos: number;
  toPos: number;
  passedGo: boolean;
}

// ── per-player redemptions (the relayer submits; players pay zero gas) ──────────

/** Redeem a player's gameplay delegation for a gasless dice roll (turn-bound). */
export async function redeemRoll(
  e: MonopolyEngine,
  signedGameplay: SignedDelegation,
  roomId: bigint,
): Promise<RollResult> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "rollAndMove", args: [roomId] });
  const exec = buildMoveExecution(e.addrs, MONOPOLY_SYSTEM_ID, inner);
  // A roll revert == "not your turn" (turn-bound enforcer) — fail fast, don't retry.
  const { txHash, blockNumber, logs } = await withRetry(() => submitRedemption(e, signedGameplay, exec), 3, false);

  // Decode the Monopoly_Rolled event from the move's own receipt logs (immune to
  // public-RPC read-after-write lag). topics: [sig, roomId, player]; data holds the
  // non-indexed (die1, die2, fromPos, toPos, passedGo).
  const log = logs.find((l) => l.address.toLowerCase() === deployment.monopolyGame.toLowerCase() && l.topics.length === 3);
  if (!log) throw new Error("no Monopoly_Rolled event in roll receipt");
  // ABI-decode the 5 non-indexed words from data.
  const d = log.data.slice(2);
  const word = (i: number) => d.slice(i * 64, (i + 1) * 64);
  const die1 = Number.parseInt(word(0), 16);
  const die2 = Number.parseInt(word(1), 16);
  const fromPos = Number.parseInt(word(2), 16);
  const toPos = Number.parseInt(word(3), 16);
  const passedGo = Number.parseInt(word(4), 16) === 1;
  return { status: "mined", txHash, blockNumber, die1, die2, fromPos, toPos, passedGo };
}

/** Redeem a player's budget delegation: real USDC transferFrom(player → Pot). The
 *  headline x402 charge (buy-in / property buy / rent — all routed to the Pot). */
export async function chargeFromPlayer(
  e: MonopolyEngine,
  signedBudget: SignedDelegation,
  player: Address,
  pot: Address,
  amount: string,
): Promise<{ status: "mined"; txHash: Hex; blockNumber: bigint }> {
  const exec = buildChargeFromExecution(e.addrs, player, pot, amount);
  const { txHash, blockNumber } = await withRetry(() => submitRedemption(e, signedBudget, exec));
  return { status: "mined", txHash, blockNumber };
}

/** Redeem a player's gameplay delegation to RECORD a non-roll action on-chain
 *  (turn-bound, gasless): buy / rent / tax / build / mortgage / jail / end. The
 *  on-chain Monopoly_Action event is the player's signed acknowledgement of the
 *  action the authoritative engine resolved. */
export async function redeemAction(
  e: MonopolyEngine,
  signedGameplay: SignedDelegation,
  roomId: bigint,
  action: string,
  spaceId: number,
  amount: bigint,
): Promise<{ status: "mined"; txHash: Hex; blockNumber: bigint }> {
  const tag = actionTag(action);
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "recordAction", args: [roomId, tag, BigInt(spaceId), amount] });
  const exec = buildMoveExecution(e.addrs, MONOPOLY_SYSTEM_ID, inner);
  // A turn-bound revert is deterministic — fail fast.
  const { txHash, blockNumber } = await withRetry(() => submitRedemption(e, signedGameplay, exec), 3, false);
  return { status: "mined", txHash, blockNumber };
}

/** Redeem a player's gameplay delegation to END their turn (turn-bound, gasless) —
 *  advances the on-chain TurnManager to the next player, signed by the player. */
export async function redeemEndTurn(
  e: MonopolyEngine,
  signedGameplay: SignedDelegation,
  roomId: bigint,
): Promise<{ status: "mined"; txHash: Hex; blockNumber: bigint }> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "endTurn", args: [roomId] });
  const exec = buildMoveExecution(e.addrs, MONOPOLY_SYSTEM_ID, inner);
  const { txHash, blockNumber } = await withRetry(() => submitRedemption(e, signedGameplay, exec), 3, false);
  return { status: "mined", txHash, blockNumber };
}

/** keccak-free bytes32 tag for an action label (right-padded UTF-8, ≤32 bytes). */
export function actionTag(label: string): Hex {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) throw new Error(`action label too long: ${label}`);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}${"00".repeat(32 - bytes.length)}` as Hex;
}

// ── admin / authority ops (relayer is TurnManager admin + game admin + Pot auth) ──

async function adminWrite(e: MonopolyEngine, to: Address, abi: readonly unknown[], fn: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await e.relayerWallet.writeContract({
    address: to,
    abi: abi as never,
    functionName: fn as never,
    args: args as never,
    account: e.relayer,
    chain: baseSepolia,
  } as never);
  await e.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function startTurns(e: MonopolyEngine, roomId: bigint, order: Address[], turnBlocks = 5_000_000n): Promise<Hex> {
  return adminWrite(e, deployment.turnManager, TURN_MANAGER_ABI, "startTurns", [roomId, order, turnBlocks]);
}

export async function openPot(e: MonopolyEngine, roomId: bigint): Promise<Hex> {
  return adminWrite(e, deployment.pot, POT_ABI, "openPot", [roomId]);
}

export async function creditDeposit(e: MonopolyEngine, roomId: bigint, player: Address, amount: string): Promise<Hex> {
  return adminWrite(e, deployment.pot, POT_ABI, "creditDeposit", [roomId, player, usdcToWei(amount)]);
}

export async function settlePot(e: MonopolyEngine, roomId: bigint, winner: Address): Promise<Hex> {
  return adminWrite(e, deployment.pot, POT_ABI, "settle", [roomId, winner]);
}

/** Advance the on-chain TurnManager by one seat (relayer is authorized). Used to keep
 *  the strictly-rotating on-chain turn in lockstep with the rules engine, which SKIPS
 *  bankrupt players. */
export async function advanceTurnAdmin(e: MonopolyEngine, roomId: bigint): Promise<Hex> {
  return adminWrite(e, deployment.turnManager, TURN_MANAGER_ABI, "advance", [roomId]);
}

/** Record a property purchase on-chain (ownership + play-cash ledger). Admin op
 *  routed through World.call so the System resolves _msgSender()==relayer(admin). */
export async function recordBuy(e: MonopolyEngine, roomId: bigint, spaceId: number, player: Address, price: bigint, rent: bigint): Promise<Hex> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "recordBuy", args: [roomId, BigInt(spaceId), player, price, rent] });
  return adminWrite(e, deployment.world, WORLD_CALL_ABI, "call", [MONOPOLY_SYSTEM_ID, inner]);
}

/** Record a rent payment on-chain (play-cash ledger). Admin op. */
export async function recordRent(e: MonopolyEngine, roomId: bigint, spaceId: number, player: Address): Promise<Hex> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "recordRent", args: [roomId, BigInt(spaceId), player] });
  return adminWrite(e, deployment.world, WORLD_CALL_ABI, "call", [MONOPOLY_SYSTEM_ID, inner]);
}

/** Set/transfer property ownership on-chain (bankruptcy transfer / clear). Admin op. */
export async function recordOwner(e: MonopolyEngine, roomId: bigint, spaceId: number, owner: Address, price: bigint, rent: bigint): Promise<Hex> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "recordOwner", args: [roomId, BigInt(spaceId), owner, price, rent] });
  return adminWrite(e, deployment.world, WORLD_CALL_ABI, "call", [MONOPOLY_SYSTEM_ID, inner]);
}

/** Mirror a player's authoritative cash + position into the World table. Admin op. */
export async function setCashOnChain(e: MonopolyEngine, roomId: bigint, player: Address, cashDollars: number, position: number): Promise<Hex> {
  const cash = BigInt(Math.max(0, Math.round(cashDollars))) * 1_000_000n; // dollars → 6dp ledger
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "setCash", args: [roomId, player, cash, BigInt(position)] });
  return adminWrite(e, deployment.world, WORLD_CALL_ABI, "call", [MONOPOLY_SYSTEM_ID, inner]);
}

/** Emit a bankruptcy event on-chain. Admin op. */
export async function recordBankrupt(e: MonopolyEngine, roomId: bigint, player: Address): Promise<Hex> {
  const inner = encodeFunctionData({ abi: MONOPOLY_ABI, functionName: "recordBankrupt", args: [roomId, player] });
  return adminWrite(e, deployment.world, WORLD_CALL_ABI, "call", [MONOPOLY_SYSTEM_ID, inner]);
}

const WORLD_CALL_ABI = [
  {
    type: "function",
    name: "call",
    inputs: [
      { name: "systemId", type: "bytes32" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── reads ─────────────────────────────────────────────────────────────────────

export async function getCurrentTurn(e: MonopolyEngine, roomId: bigint): Promise<Address> {
  return (await e.publicClient.readContract({
    address: deployment.turnManager,
    abi: TURN_MANAGER_ABI,
    functionName: "getCurrent",
    args: [roomId],
  })) as Address;
}

export async function getCash(e: MonopolyEngine, roomId: bigint, player: Address): Promise<bigint> {
  return (await e.publicClient.readContract({ address: deployment.monopolyGame, abi: MONOPOLY_ABI, functionName: "cashOf", args: [roomId, player] })) as bigint;
}

export async function getOwner(e: MonopolyEngine, roomId: bigint, spaceId: number): Promise<Address> {
  return (await e.publicClient.readContract({ address: deployment.monopolyGame, abi: MONOPOLY_ABI, functionName: "ownerOf", args: [roomId, BigInt(spaceId)] })) as Address;
}

export async function usdcBalance(e: MonopolyEngine, addr: Address): Promise<bigint> {
  return (await e.publicClient.readContract({ address: deployment.usdc, abi: USDC_ABI, functionName: "balanceOf", args: [addr] })) as bigint;
}

/** Wait for the TurnManager's getCurrent to reflect `expected` (read-after-write lag). */
export async function waitForTurn(e: MonopolyEngine, roomId: bigint, expected: Address, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const cur = await getCurrentTurn(e, roomId);
    if (cur.toLowerCase() === expected.toLowerCase()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
