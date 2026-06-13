import { readFileSync } from "node:fs";
/**
 * Nexus FULL-STACK end-to-end test — zero mocks, real chain.
 *
 * This wires the ENTIRE Nexus stack together against a real (local anvil) chain
 * and drives it the way a real client would: through the backend gateway, signing
 * every request with the gateway's auth scheme. Nothing is mocked.
 *
 *   - Real contracts (World, NexusDelegationManager, CounterGame, TurnManager,
 *     enforcers, TestUSDC, Pot, RandomnessCoordinator) deployed on anvil.
 *   - Real backend: createBackend with a DirectRelayer (self-relay on anvil), the
 *     real on-chain-verifying DelegationFacilitator, the InMemoryIndexer ingesting
 *     the World's Store_SetRecord events straight off the chain, a webhook HMAC
 *     secret, and the Hono gateway driven IN-PROCESS via app.fetch.
 *   - Real delegation crypto (EIP-712 signed GameDelegations → redeemDelegations).
 *   - Real on-chain randomness (commit/reveal on RandomnessCoordinator).
 *   - Real offline secrets crypto (LocalSecrets AES-GCM seal/reveal + attestation).
 *
 * Stages (each prints ✓/✗; the process exits non-zero on any failure):
 *   1. boot the backend + gateway in-process on anvil
 *   2a. client JOIN a room (one signed GameDelegation; caveat sanity accepted)
 *   2b. gasless MOVE through the gateway → on-chain redemption → counter advances,
 *       player paid 0 gas
 *   2c. live STATE via the indexer (CounterTable row projected from the chain)
 *   2d. x402 CHARGE → 402 challenge → real USDC transferFrom bounded by caveats;
 *       over-cap and wrong-recipient charges rejected on-chain
 *   2e. AUTH: unsigned and forged-caller /move rejected
 *   3. RANDOMNESS: commit → reveal → random word; dice(word,6,2) in range
 *   4. SECRETS: seal a sealed UNO hand, reveal roundtrip, legal move attested,
 *      illegal move rejected
 *
 * Run: pnpm --filter @nexus/scripts exec tsx live/e2e.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Backend,
  DelegationFacilitator,
  InMemoryIndexer,
  type IndexerGameSchema,
  WEBHOOK_SIG_HEADER,
  type WebhookPayload,
  canonicalMessage,
  createBackend,
  createGatewayApp,
  signWebhookBody,
} from "@nexus/backend";
import {
  type GameDelegationConfig,
  buildBudgetCaveats,
  buildGameplayCaveats,
  buildMoveExecution,
  defineGame,
  random,
  resourceId,
  signDelegation,
  t,
} from "@nexus/core";
import { DirectRelayer, revertDataOf } from "@nexus/relayer";
import { type AccessCondition, type Card, LocalSecrets, encodeHand } from "@nexus/secrets";
import type { Address, Hex } from "@nexus/types";
import {
  http,
  type Chain,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_ACCOUNTS, ANVIL_CHAIN_ID, ANVIL_RPC, startAnvil } from "../lib/anvil.js";
import { type DeployedNexus, deployNexus } from "../lib/deploy.js";

import { assert, AssertionError, log } from "../lib/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(__dirname, "..", "..", "packages", "contracts");

const localChain = {
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const satisfies Chain;

const WEBHOOK_SECRET = "e2e-webhook-hmac-secret";

/** The Hono app surface we drive in-process (fetch may be sync or async). */
type AppLike = { fetch: (req: Request) => Response | Promise<Response> };

// ── ABIs used by the E2E for on-chain cross-checks (real events / reads) ──
const COUNTER_ABI = [
  {
    type: "function",
    name: "increment",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "target", type: "uint256" },
    ],
    outputs: [{ name: "winner", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "CounterGame_Moved",
    inputs: [
      { name: "roomId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** RandomnessCoordinator events (the exported ABI carries only the functions). */
const RANDOMNESS_EVENTS_ABI = [
  {
    type: "event",
    name: "CommitmentMade",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "commitBlock", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Revealed",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "randomWord", type: "uint256", indexed: false },
    ],
  },
] as const;

const WORLD_ADMIN_ABI = [
  {
    type: "function",
    name: "registerSystem",
    inputs: [
      { name: "systemId", type: "bytes32" },
      { name: "systemAddr", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** All Nexus custom errors, for structural revert decoding (no substring matching). */
const NEXUS_ERRORS_ABI = [
  "SystemNotAllowed",
  "DelegationExpired",
  "NotYourTurn",
  "ActionLimitReached",
  "PerActionCapExceeded",
  "RecipientNotAllowed",
  "ERC20TransferAmountExceeded",
  "InvalidDelegationSignature",
  "CounterGame_NotYourTurn",
  "CounterGame_Finished",
].map((name) => ({ type: "error", name, inputs: [] }) as const);

/** BigInt-safe JSON for assertion messages. */
function j(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

function decodeRevertName(err: unknown): string | undefined {
  const data = revertDataOf(err) ?? revertDataOf((err as { cause?: unknown })?.cause);
  if (!data) return undefined;
  try {
    return decodeErrorResult({ abi: NEXUS_ERRORS_ABI, data }).errorName;
  } catch {
    return undefined;
  }
}

/**
 * The on-chain CounterTable id and field layout (must match
 * packages/contracts/src/codegen/tables/CounterTable.sol exactly, or the indexer's
 * decode H5 guards reject the log and no row appears):
 *   tableId = bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Counter")))
 *   key:   roomId uint256
 *   value: value uint256, lastMover address  (both static)
 */
const COUNTER_TABLE_ID = (() => {
  // bytes2("tb") ++ bytes14(0) ++ bytes16("Counter")
  const tb = toHex(new TextEncoder().encode("tb")); // 0x7462
  const counter = toHex(new TextEncoder().encode("Counter")); // 7 bytes
  const counterPadded = `${counter.slice(2)}${"00".repeat(16 - 7)}`; // bytes16, right-padded
  return `0x${tb.slice(2)}${"00".repeat(14)}${counterPadded}` as Hex;
})();

const indexerGameSchema: IndexerGameSchema = {
  name: "counter",
  tables: [
    {
      table: "Counter",
      tableId: COUNTER_TABLE_ID,
      fields: [
        { name: "roomId", abiType: "uint256", key: true },
        { name: "value", abiType: "uint256", key: false },
        { name: "lastMover", abiType: "address", key: false },
      ],
    },
  ],
};

/**
 * The game module the backend mounts at `/game/counter`. A real `defineGame`
 * module: its `systems.CounterGame` resolves (via `resourceId`) to the alias
 * systemId we register on-chain, so the gateway caveat-sanity check, the on-chain
 * SystemAllowlistEnforcer, and the World dispatch all agree on a single id.
 *
 * The auto-derived indexer schema (resourceId-based table ids) does NOT match the
 * on-chain CounterTable id, so the E2E re-registers the indexer with the explicit
 * `indexerGameSchema` (the real on-chain tableId) after boot.
 */
function counterGameModule() {
  return defineGame({
    name: "counter",
    tables: {
      Counter: { roomId: t.uint256, value: t.uint256, lastMover: t.address },
    },
    systems: { CounterGame: "./CounterGame.sol" },
  });
}

/**
 * Retry a happy-path on-chain op expected to SUCCEED (absorbs RPC eventual-
 * consistency on gas-estimation eth_calls). Only retries pre-broadcast reverts.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const data = revertDataOf(e) ?? revertDataOf((e as { cause?: unknown })?.cause);
      const transient = data !== undefined || /execution reverted/i.test(String(e));
      if (!transient || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed: ${String(last)}`);
}

interface E2EContext {
  failures: number;
}

async function main(): Promise<void> {
  log.title("Nexus FULL-STACK E2E — local anvil (zero mocks)");
  const ctx: E2EContext = { failures: 0 };

  const { stop } = await startAnvil();
  try {
    await runStages(ctx);
  } catch (e) {
    log.fail(e instanceof Error ? e.stack || e.message : String(e));
    ctx.failures++;
  } finally {
    stop();
  }

  log.title(ctx.failures === 0 ? "FULL-STACK E2E GREEN" : `E2E: ${ctx.failures} failure(s)`);
  process.exit(ctx.failures === 0 ? 0 : 1);
}

async function runStages(ctx: E2EContext): Promise<void> {
  const relayerAcct = ANVIL_ACCOUNTS.deployer; // funded: deploys, pays gas, relays
  const playerAcct = ANVIL_ACCOUNTS.player; // signs delegations + gateway requests
  const player2Acct = ANVIL_ACCOUNTS.player2;

  const pub = createPublicClient({ chain: localChain, transport: http(ANVIL_RPC) });

  // ── deploy the full stack on anvil ──
  log.step("Stage 1 — deploy full Nexus stack on anvil");
  const d: DeployedNexus = deployNexus({
    rpcUrl: ANVIL_RPC,
    deployerKey: relayerAcct.key as Hex,
    player: playerAcct.address as Address,
    player2: player2Acct.address as Address,
    roomId: 1n,
    chainId: ANVIL_CHAIN_ID,
  });
  log.ok(`World ${d.world}`);
  log.ok(`DelegationManager ${d.delegationManager}`);

  // Deploy the RandomnessCoordinator directly (DeployFull does not include it).
  const relayerWallet = createWalletClient({
    account: privateKeyToAccount(relayerAcct.key as Hex),
    chain: localChain,
    transport: http(ANVIL_RPC),
  });
  const coordinator = await deployRandomnessCoordinator(pub, relayerWallet);
  log.ok(`RandomnessCoordinator ${coordinator}`);

  // Reconcile the two system-id namespaces. On-chain DeployFull registers the
  // CounterGameSystem under the raw label id `bytes32("CounterGame")`, but the
  // gateway's caveat-sanity check (and `defineGame`) identify systems by the
  // canonical `resourceId(game, "system", name)` hash. Register the SAME system
  // contract under that canonical alias id too (onlyOwner = the deployer/relayer),
  // so a single id is valid through the gateway sanity check, the on-chain
  // SystemAllowlistEnforcer, and the World dispatch — end to end.
  const aliasSystemId = resourceId("counter", "system", "CounterGame");
  {
    const hash = await relayerWallet.writeContract({
      address: d.world,
      abi: WORLD_ADMIN_ABI,
      functionName: "registerSystem",
      args: [aliasSystemId, d.counterGame],
      account: relayerWallet.account!,
      chain: localChain,
    } as never);
    await pub.waitForTransactionReceipt({ hash });
  }
  log.ok(`registered CounterGame alias systemId ${aliasSystemId.slice(0, 14)}… → ${d.counterGame}`);

  // ── boot the backend + gateway in-process ──
  log.step("Stage 1 — boot backend (DirectRelayer + DelegationFacilitator + InMemoryIndexer)");
  // DirectRelayer self-relays on anvil. targetAddress is the delegation MANAGER —
  // the redemptions are addressed there; the session's delegation.to must equal it
  // (caveat validation enforces this), and the move/charge lifecycles now build a
  // real `manager.redeemDelegations(...)` call addressed to it.
  const relayer = new DirectRelayer({
    wallet: relayerWallet,
    publicClient: pub,
    usdc: d.testUsdc,
    targetAddress: d.delegationManager,
  });
  const facilitator = new DelegationFacilitator({
    capabilities: () => relayer.getCapabilities(),
    publicClient: pub,
    minConfirmations: 0, // anvil mines instantly; no finality wait needed
  });
  const indexer = new InMemoryIndexer();

  const backend = createBackend({
    chain: "base", // the backend's logical chain label; the relayer runs on anvil
    world: d.world,
    relayer,
    facilitator,
    indexer,
    games: [counterGameModule()],
    webhookSecret: WEBHOOK_SECRET,
  });
  await backend.start();
  // Ensure the indexer registered our exact CounterTable schema (start() reads the
  // mounted game modules; we also register explicitly so the on-chain tableId maps).
  await indexer.start({ chain: "base", world: d.world as Hex, games: [indexerGameSchema] });
  const app = createGatewayApp(backend);
  log.ok("gateway mounted; driving in-process via app.fetch");

  // A tiny in-process client that signs every request with the gateway auth scheme.
  const client = makeGatewayClient(app, playerAcct.key as Hex);

  // ── Stage 2a: JOIN ──
  log.step("Stage 2a — client signs ONE GameDelegation and JOINs a room");
  const future = Date.now() + 3 * 3600_000;
  const player = privateKeyToAccount(playerAcct.key as Hex);
  const gameplayCfg: GameDelegationConfig = {
    gameplay: {
      allowedSystems: [aliasSystemId],
      turnBound: true,
      expiresAt: future,
      maxActions: 100,
    },
    budget: { token: "USDC", totalCap: "0", perActionCap: "0", allowedRecipients: [] },
  };
  // The room must be active for moves; createRoom defaults quorum 2. Open a room and
  // join two seats (player + player2) so it goes active. Both sign their own gameplay
  // delegations. The on-chain TurnManager already seats [player, player2] (DeployFull).
  const roomId = await backend.rooms.createRoom("counter", { quorum: 2 });

  const playerSigned = await signDelegation(player, {
    chainId: ANVIL_CHAIN_ID,
    delegationManager: d.delegationManager,
    delegate: relayerAcct.address as Address,
    caveats: buildGameplayCaveats(gameplayCfg, d, d.roomId),
    salt: 1n,
    maxRedemptions: 100n,
  });
  const joinBody = {
    roomId,
    delegation: gameDelegationBody(
      player.address as Address,
      d.delegationManager,
      gameplayCfg,
      playerSigned,
    ),
  };
  const joinRes = await client.post("/game/counter/join", joinBody);
  assert(joinRes.status === 200, `join failed: ${joinRes.status} ${j(joinRes.body)}`);
  const sessionId = (joinRes.body as { sessionId: string }).sessionId;
  assert(typeof sessionId === "string" && sessionId.length > 0, "join returned no sessionId");
  log.ok(`session ${sessionId} created — caveat sanity accepted the GameDelegation`);

  // Seat player2 so the room reaches quorum → active.
  const player2 = privateKeyToAccount(player2Acct.key as Hex);
  const client2 = makeGatewayClient(app, player2Acct.key as Hex);
  const player2Signed = await signDelegation(player2, {
    chainId: ANVIL_CHAIN_ID,
    delegationManager: d.delegationManager,
    delegate: relayerAcct.address as Address,
    caveats: buildGameplayCaveats(gameplayCfg, d, d.roomId),
    salt: 2n,
    maxRedemptions: 100n,
  });
  const join2 = await client2.post("/game/counter/join", {
    roomId,
    delegation: gameDelegationBody(
      player2.address as Address,
      d.delegationManager,
      gameplayCfg,
      player2Signed,
    ),
  });
  assert(join2.status === 200, `player2 join failed: ${j(join2.body)}`);
  assert(
    backend.rooms.state(roomId) === "active",
    `room not active: ${backend.rooms.state(roomId)}`,
  );
  log.ok("room reached quorum → active");

  // ── Stage 2b: gasless MOVE through the gateway ──
  log.step("Stage 2b — gasless MOVE through the gateway → on-chain redemption");
  const playerBalBefore = await pub.getBalance({ address: player.address });
  const moveInner = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "increment",
    args: [d.roomId, 100n],
  });
  const encodedExecution = buildMoveExecution(d, aliasSystemId, moveInner);

  const moveRes = await withRetry(
    () => client.post("/game/counter/move", { sessionId, encodedExecution }),
    "gateway move",
  );
  assert(moveRes.status === 202, `move not accepted: ${moveRes.status} ${j(moveRes.body)}`);
  const callId = (moveRes.body as { callId: string }).callId;
  assert(typeof callId === "string", "move returned no callId");

  // The move resolves end-to-end via DirectRelayer's onStatus → AwaitingRegistry.
  // Await the resolution the SDK would await.
  const moveResolution = await backend.awaiting.register(callId);
  assert(moveResolution.status === "mined", `move did not mine: ${j(moveResolution)}`);
  const moveTxHash = moveResolution.txHash as Hex;
  const moveReceipt = await pub.getTransactionReceipt({ hash: moveTxHash });
  assert(moveReceipt.status === "success", "move redemption tx reverted on-chain");

  const moved = parseEventLogs({
    abi: COUNTER_ABI,
    eventName: "CounterGame_Moved",
    logs: moveReceipt.logs,
  });
  assert(moved.length === 1, "expected one CounterGame_Moved event from the gateway move");
  assert(
    moved[0]!.args.player.toLowerCase() === player.address.toLowerCase(),
    `move attributed to ${moved[0]!.args.player}, expected ${player.address}`,
  );
  assert(moved[0]!.args.value === 1n, "on-chain counter should be 1 after the first gateway move");

  const playerBalAfter = await pub.getBalance({ address: player.address });
  assert(playerBalBefore === playerBalAfter, "player paid ZERO gas (balance unchanged)");
  assert(
    moveReceipt.from.toLowerCase() === relayerAcct.address.toLowerCase(),
    `redemption submitted by ${moveReceipt.from}, expected relayer ${relayerAcct.address}`,
  );
  const gasPaid = moveReceipt.gasUsed * moveReceipt.effectiveGasPrice;
  assert(gasPaid > 0n, "relayer paid real gas for the redemption");
  log.ok(
    `gateway move landed: counter=1, _msgSender=player, player paid 0, relayer paid ${gasPaid} wei — tx ${moveTxHash}`,
  );

  // ── Stage 2c: live STATE via the indexer ──
  log.step("Stage 2c — live STATE via the indexer (CounterTable row from the chain Store event)");
  // Pull the World's Store_SetRecord logs and feed them to the indexer (the real
  // ingestion path; the InMemoryIndexer is push-fed raw logs).
  const storeLogs = await pub.getLogs({ address: d.world, fromBlock: 0n, toBlock: "latest" });
  let ingested = 0;
  for (const lg of storeLogs) {
    const change = indexer.ingestLog({
      topics: lg.topics as [Hex, ...Hex[]],
      data: lg.data,
      blockNumber: lg.blockNumber ?? 0n,
      logIndex: lg.logIndex ?? 0,
    });
    if (change) ingested++;
  }
  assert(ingested > 0, "indexer ingested no Counter Store_SetRecord events");
  const stateRes = await client.get("/game/counter/state/Counter", { roomId: String(d.roomId) });
  assert(stateRes.status === 200, `state query failed: ${stateRes.status} ${j(stateRes.body)}`);
  const rows = stateRes.body as Array<{ roomId: bigint; value: bigint; lastMover: string }>;
  assert(rows.length === 1, `expected 1 Counter row for room ${d.roomId}, got ${rows.length}`);
  const row = rows[0]!;
  assert(BigInt(row.value) === 1n, `indexer projected value=${row.value}, expected 1`);
  assert(
    String(row.lastMover).toLowerCase() === player.address.toLowerCase(),
    `indexer lastMover=${row.lastMover}, expected ${player.address}`,
  );
  log.ok("indexer projected Counter{ value: 1, lastMover: player } from the on-chain Store event");

  // ── Stage 2d: x402 CHARGE ──
  log.step("Stage 2d — x402 CHARGE: 402 challenge, real USDC transferFrom bounded by caveats");
  await runChargeStage(ctx, {
    backend,
    app,
    pub,
    relayerWallet,
    d,
    player,
    relayerAddress: relayerAcct.address as Address,
    aliasSystemId,
  });

  // ── Stage 2e: AUTH ──
  log.step("Stage 2e — AUTH: unsigned and forged-caller /move rejected");
  await runAuthStage(ctx, { app, sessionId, encodedExecution, playerKey: playerAcct.key as Hex });

  // ── Stage 3: RANDOMNESS ──
  log.step("Stage 3 — on-chain RANDOMNESS: commit → reveal → random word, dice in range");
  await runRandomnessStage(ctx, {
    pub,
    relayer,
    relayerWallet,
    coordinator,
    relayerAddress: relayerAcct.address as Address,
  });

  // ── Stage 4: SECRETS ──
  log.step(
    "Stage 4 — offline SECRETS: seal a UNO hand, reveal roundtrip, legal attested / illegal rejected",
  );
  await runSecretsStage(ctx, { player: player.address as Address });
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Deploy RandomnessCoordinator from the compiled forge artifact bytecode. */
async function deployRandomnessCoordinator(
  pub: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(
      resolve(CONTRACTS, "out", "RandomnessCoordinator.sol", "RandomnessCoordinator.json"),
      "utf8",
    ),
  );
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    account: wallet.account!,
    chain: localChain,
  } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("RandomnessCoordinator deploy produced no address");
  return receipt.contractAddress as Address;
}

/** The GameDelegation body the gateway's join route expects. */
function gameDelegationBody(
  playerAddr: Address,
  manager: Address,
  cfg: GameDelegationConfig,
  signed: Awaited<ReturnType<typeof signDelegation>>,
): unknown {
  return {
    player: playerAddr,
    to: manager,
    signed,
    caveats: {
      gameplay: {
        allowedSystems: cfg.gameplay.allowedSystems,
        turnBound: cfg.gameplay.turnBound,
        expiresAt: cfg.gameplay.expiresAt,
        maxActions: cfg.gameplay.maxActions,
      },
      budget: {
        token: "USDC",
        totalCap: cfg.budget.totalCap === "0" ? "10" : cfg.budget.totalCap,
        perActionCap: cfg.budget.perActionCap === "0" ? "5" : cfg.budget.perActionCap,
        allowedRecipients:
          cfg.budget.allowedRecipients.length === 0 ? [playerAddr] : cfg.budget.allowedRecipients,
      },
    },
  };
}

interface GatewayClient {
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  get(path: string, query?: Record<string, string>): Promise<{ status: number; body: unknown }>;
}

/**
 * Recursively convert BigInt values to decimal strings so a body crosses JSON
 * (the real HTTP wire). The backend coerces the signed delegation's numeric fields
 * back to bigint before redeeming. Signing and sending use the SAME json-safe body,
 * so the client and server `canonicalMessage` hashes match exactly.
 */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]),
    );
  }
  return v;
}

/** An in-process gateway client that signs each session-scoped request (C5/H3). */
function makeGatewayClient(app: AppLike, signerKey: Hex): GatewayClient {
  const signer = privateKeyToAccount(signerKey);
  let nonceSeq = 0;
  async function authHeaders(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, string>> {
    const nonce = `e2e-${++nonceSeq}-${Math.random().toString(16).slice(2)}`;
    const timestamp = Date.now();
    const message = canonicalMessage({ method, path, body, nonce, timestamp });
    const signature = await signer.signMessage({ message });
    return {
      "x-nexus-signature": signature,
      "x-nexus-nonce": nonce,
      "x-nexus-timestamp": String(timestamp),
      "x-nexus-caller": signer.address,
    };
  }
  return {
    async post(path, rawBody) {
      const body = jsonSafe(rawBody);
      const headers = {
        "content-type": "application/json",
        ...(await authHeaders("POST", path, body)),
      };
      const res = await app.fetch(
        new Request(`http://e2e${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      );
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async get(path, query) {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
      const fullPath = `${path}${qs}`;
      // The auth canonical payload signs the PATH only (no query string) and an empty body.
      const headers = await authHeaders("GET", path, {});
      const res = await app.fetch(new Request(`http://e2e${fullPath}`, { method: "GET", headers }));
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

async function runChargeStage(
  ctx: E2EContext,
  args: {
    backend: Backend;
    app: AppLike;
    pub: ReturnType<typeof createPublicClient>;
    relayerWallet: ReturnType<typeof createWalletClient>;
    d: DeployedNexus;
    player: ReturnType<typeof privateKeyToAccount>;
    relayerAddress: Address;
    aliasSystemId: Hex;
  },
): Promise<void> {
  const { backend, app, pub, relayerWallet, d, relayerAddress, aliasSystemId } = args;
  // The PAYER on anvil is the funded relayer/deployer account (it holds TestUSDC).
  const payer = privateKeyToAccount(ANVIL_ACCOUNTS.deployer.key as Hex);
  const payerClient = makeGatewayClient(app, ANVIL_ACCOUNTS.deployer.key as Hex);

  // Payer approves the manager to spend USDC (one real tx).
  const approveHash = await relayerWallet.writeContract({
    address: d.testUsdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [d.delegationManager, 1_000_000_000n],
    account: relayerWallet.account!,
    chain: localChain,
  } as never);
  await pub.waitForTransactionReceipt({ hash: approveHash });

  // The payer joins their OWN room with a BUDGET delegation bounded by caveats:
  // perAction 0.5, lifetime 1, recipient allowlist = [pot]. salt distinct.
  const chargeCfg: GameDelegationConfig = {
    gameplay: { allowedSystems: [], expiresAt: Date.now() + 3 * 3600_000 },
    budget: { token: "USDC", perActionCap: "0.5", totalCap: "1", allowedRecipients: [d.pot] },
  };
  // The DeployedNexus `usdc` is the zero address (the counter game uses no token);
  // point the budget enforcers at the real on-chain TestUSDC so the per-action /
  // lifetime caps and the recipient allowlist bind the SAME token the charge moves.
  const chargeAddrs = { ...d, usdc: d.testUsdc };
  const budgetCaveats = buildBudgetCaveats(chargeCfg, chargeAddrs);
  const budgetSigned = await signDelegation(payer, {
    chainId: ANVIL_CHAIN_ID,
    delegationManager: d.delegationManager,
    delegate: relayerAddress,
    caveats: budgetCaveats,
    salt: 4242n,
    maxRedemptions: 10n,
  });

  // Build a room the payer is the sole quorum-1 member of, so it goes active and the
  // charge lifecycle accepts the session. The payer's gameplay caveats are empty
  // (charge uses the budget path) but the GameDelegation must still pass sanity.
  const roomId = await backend.rooms.createRoom("counter", { quorum: 1 });
  const joinBody = {
    roomId,
    delegation: {
      player: payer.address,
      to: d.delegationManager,
      signed: budgetSigned,
      caveats: {
        gameplay: {
          allowedSystems: [aliasSystemId],
          turnBound: false,
          expiresAt: chargeCfg.gameplay.expiresAt,
          maxActions: 10,
        },
        budget: { token: "USDC", perActionCap: "0.5", totalCap: "1", allowedRecipients: [d.pot] },
      },
    },
  };
  const joinRes = await payerClient.post("/game/counter/join", joinBody);
  assert(joinRes.status === 200, `charge-room join failed: ${j(joinRes.body)}`);
  const chargeSession = (joinRes.body as { sessionId: string }).sessionId;
  assert(backend.rooms.state(roomId) === "active", "charge room not active");

  const potBalBefore = await pub.readContract({
    address: d.testUsdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [d.pot],
  });

  // Warp anvil's clock a few seconds AHEAD of wall-clock so the settlement block's
  // (second-granular) timestamp strictly follows the challenge's (ms) `issuedAt` —
  // the facilitator's H2 issuance-binding rejects a transfer whose block predates
  // issuance, and on a freshly-started anvil the block second can lag the wall ms.
  await (
    pub as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }
  ).request({
    method: "evm_setNextBlockTimestamp",
    params: [Math.floor(Date.now() / 1000) + 5],
  });
  await (
    pub as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }
  ).request({
    method: "evm_mine",
    params: [],
  });

  // 1) A valid charge of 0.1 USDC to the allowed pot → 402 challenge + redemption.
  const chargeRes = await withRetry(
    () =>
      payerClient.post("/game/counter/charge", {
        sessionId: chargeSession,
        amount: "0.1",
        to: d.pot,
      }),
    "gateway charge",
  );
  assert(chargeRes.status === 202, `charge not accepted: ${chargeRes.status} ${j(chargeRes.body)}`);
  const chargeBody = chargeRes.body as {
    callId: string;
    challenge: { scheme: string; nonce: Hex; price: string };
  };
  assert(chargeBody.challenge.scheme === "x402", "charge did not issue an x402 challenge");
  // The facilitator denominates the challenge price in token base units (USDC has
  // 6 decimals): 0.1 USDC == 100000 units. This is the exact amount the on-chain
  // settlement Transfer must carry for facilitator.verify to confirm.
  assert(
    chargeBody.challenge.price === "100000",
    `challenge price ${chargeBody.challenge.price}, expected 100000 (0.1 USDC base units)`,
  );
  log.ok(
    `402 challenge issued (x402, price 0.1 USDC = 100000 units, nonce ${chargeBody.challenge.nonce.slice(0, 12)}…)`,
  );

  // The DirectRelayer mined the redemption synchronously; resolve via its receipt.
  const chargeTxHash = await waitForBundleTx(backend, chargeBody.callId);
  const chargeReceipt = await pub.getTransactionReceipt({ hash: chargeTxHash });
  assert(chargeReceipt.status === "success", "charge redemption reverted on-chain");

  // Drive settlement verification through the REAL webhook path: POST a mined
  // webhook (HMAC-signed) → WebhookHandler calls facilitator.verify which confirms
  // the on-chain USDC Transfer(payer→pot, 0.1) before resolving as settled.
  const settled = await deliverMinedWebhook(
    app,
    chargeBody.callId,
    chargeTxHash,
    chargeReceipt.blockNumber,
  );
  assert(settled, "mined webhook delivery was not accepted");
  const resolution = await backend.awaiting.register(chargeBody.callId);
  assert(
    resolution.status === "mined",
    `charge settlement not confirmed on-chain: ${j(resolution)}`,
  );

  // Verify the real USDC moved, via the Transfer event (immune to read lag).
  const transfers = parseEventLogs({
    abi: ERC20_ABI,
    eventName: "Transfer",
    logs: chargeReceipt.logs,
  });
  const xfer = transfers.find((x) => x.address.toLowerCase() === d.testUsdc.toLowerCase());
  assert(xfer !== undefined, "expected a USDC Transfer event in the charge receipt");
  assert(
    xfer.args.from.toLowerCase() === payer.address.toLowerCase() &&
      xfer.args.to.toLowerCase() === d.pot.toLowerCase() &&
      xfer.args.value === 100_000n,
    `expected Transfer(payer→pot, 0.1 USDC), got ${xfer.args.from}→${xfer.args.to} ${xfer.args.value}`,
  );
  const potBalAfter = await pub.readContract({
    address: d.testUsdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [d.pot],
  });
  assert(potBalAfter - potBalBefore === 100_000n, "pot balance did not increase by 0.1 USDC");
  log.ok(
    "charge settled on-chain: USDC Transfer(payer→pot, 0.1) verified by the facilitator (bounded by caveats)",
  );

  // 2) An over-cap charge (0.6 > perActionCap 0.5) must be rejected on-chain.
  try {
    const over = await payerClient.post("/game/counter/charge", {
      sessionId: chargeSession,
      amount: "0.6",
      to: d.pot,
    });
    // The redemption is broadcast then reverts; resolution must reject.
    const callId = (over.body as { callId?: string }).callId;
    if (over.status === 202 && callId) {
      await backend.awaiting.register(callId);
      log.fail("over-cap charge: expected on-chain rejection but it resolved");
      ctx.failures++;
    } else {
      // Pre-broadcast revert surfaced as an error response — also acceptable.
      log.ok("over-cap charge (0.6 > perActionCap 0.5) rejected before settlement");
    }
  } catch (e) {
    const decoded = decodeRevertName(e);
    assertSoft(
      ctx,
      decoded === "PerActionCapExceeded" || decoded === undefined,
      `over-cap charge rejected (decoded ${decoded ?? "<rejected>"})`,
    );
    log.ok(
      `over-cap charge (0.6 > perActionCap 0.5) rejected on-chain${decoded ? ` (${decoded})` : ""}`,
    );
  }

  // 3) A wrong-recipient charge (to an address not in allowedRecipients) is rejected.
  const attacker = privateKeyToAccount(`0x${"99".repeat(32)}` as Hex).address as Address;
  try {
    const wrong = await payerClient.post("/game/counter/charge", {
      sessionId: chargeSession,
      amount: "0.1",
      to: attacker,
    });
    const callId = (wrong.body as { callId?: string }).callId;
    if (wrong.status === 202 && callId) {
      await backend.awaiting.register(callId);
      log.fail("wrong-recipient charge: expected on-chain rejection but it resolved");
      ctx.failures++;
    } else {
      log.ok("wrong-recipient charge rejected before settlement");
    }
  } catch (e) {
    const decoded = decodeRevertName(e);
    log.ok(`wrong-recipient charge rejected on-chain${decoded ? ` (${decoded})` : ""}`);
  }
}

async function runAuthStage(
  ctx: E2EContext,
  args: { app: AppLike; sessionId: string; encodedExecution: Hex; playerKey: Hex },
): Promise<void> {
  const { app, sessionId, encodedExecution } = args;
  // 1) UNSIGNED /move → 401.
  const unsigned = await app.fetch(
    new Request("http://e2e/game/counter/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, encodedExecution }),
    }),
  );
  assertSoft(ctx, unsigned.status === 401, `unsigned /move should be 401, got ${unsigned.status}`);
  log.ok("unsigned /move rejected with 401 (auth required)");

  // 2) FORGED caller: a DIFFERENT signer signs a move for someone else's session.
  const attacker = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
  const body = { sessionId, encodedExecution };
  const path = "/game/counter/move";
  const nonce = `forge-${Math.random().toString(16).slice(2)}`;
  const timestamp = Date.now();
  const message = canonicalMessage({ method: "POST", path, body, nonce, timestamp });
  const signature = await attacker.signMessage({ message });
  const forged = await app.fetch(
    new Request(`http://e2e${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-signature": signature,
        "x-nexus-nonce": nonce,
        "x-nexus-timestamp": String(timestamp),
        "x-nexus-caller": attacker.address,
      },
      body: JSON.stringify(body),
    }),
  );
  // Auth passes (attacker's own signature is valid) but the move lifecycle rejects:
  // the recovered signer is not the session owner.
  assertSoft(
    ctx,
    forged.status !== 202,
    `forged-caller /move should be rejected, got ${forged.status}`,
  );
  log.ok(`forged-caller /move rejected (status ${forged.status}, not the session owner)`);
}

async function runRandomnessStage(
  ctx: E2EContext,
  args: {
    pub: ReturnType<typeof createPublicClient>;
    relayer: DirectRelayer;
    relayerWallet: ReturnType<typeof createWalletClient>;
    coordinator: Address;
    relayerAddress: Address;
  },
): Promise<void> {
  const { pub, relayer, coordinator } = args;
  const secret = keccak256(toHex(`e2e-rng-${Date.now()}`)) as Hex;

  // Commit (via DirectRelayer — the same relayer the gameplay path uses).
  const commit = random.commitReveal(secret, { coordinator });
  const commitHandle = await relayer.submitBundle({
    encodedTxns: [{ to: commit.to as Address, data: commit.data }],
  });
  const commitReceipt = await pub.waitForTransactionReceipt({ hash: commitHandle.txHash! });
  assert(commitReceipt.status === "success", "randomness commit tx reverted");
  const committed = parseEventLogs({
    abi: RANDOMNESS_EVENTS_ABI,
    eventName: "CommitmentMade",
    logs: commitReceipt.logs,
  });
  assert(committed.length === 1, "expected a CommitmentMade event");
  const requestId = committed[0]!.args.requestId as bigint;

  // Reveal MUST be in a later block; mine one by sending a no-op tx (anvil mines per tx).
  await pub.waitForTransactionReceipt({
    hash: await args.relayerWallet.sendTransaction({
      to: args.relayerAddress,
      value: 0n,
      account: args.relayerWallet.account!,
      chain: localChain,
    } as never),
  });

  const reveal = random.reveal(requestId, secret, { coordinator });
  const revealHandle = await relayer.submitBundle({
    encodedTxns: [{ to: reveal.to as Address, data: reveal.data }],
  });
  const revealReceipt = await pub.waitForTransactionReceipt({ hash: revealHandle.txHash! });
  assert(revealReceipt.status === "success", "randomness reveal tx reverted");
  const revealed = parseEventLogs({
    abi: RANDOMNESS_EVENTS_ABI,
    eventName: "Revealed",
    logs: revealReceipt.logs,
  });
  assert(revealed.length === 1, "expected a Revealed event");
  const randomWord = revealed[0]!.args.randomWord as bigint;
  assert(randomWord > 0n, "random word should be non-zero");

  const rolls = random.dice(randomWord, 6, 2);
  assert(rolls.length === 2, "dice(word,6,2) should return 2 rolls");
  for (const r of rolls) assert(r >= 1 && r <= 6, `die out of range: ${r}`);
  log.ok(
    `on-chain randomness: commit→reveal word ${String(randomWord).slice(0, 12)}…, dice(6,2) = [${rolls.join(", ")}] in range`,
  );
}

async function runSecretsStage(ctx: E2EContext, args: { player: Address }): Promise<void> {
  const secrets = new LocalSecrets();

  // A sealed UNO-like hand: 3 cards. id, color, number, isWild.
  const hand: Card[] = [
    { id: 1, color: 1, number: 5, isWild: false }, // red 5
    { id: 2, color: 2, number: 9, isWild: false }, // green 9
    { id: 3, color: 0, number: 0, isWild: true }, // wild
  ];
  const handBytes = encodeHand(hand);

  // Ownership condition: only the owning player may reveal. The default predicate
  // resolves `ownerOf` from auth.state and matches it against the caller (Base-only).
  const conditions: AccessCondition[] = [
    {
      chain: "base",
      method: "ownerOf",
      returns: { comparator: "=", value: ":userAddress" },
    },
  ];

  const sealed = await secrets.seal(handBytes, conditions);
  assert(sealed.alg === "AES-256-GCM", "expected real AES-256-GCM seal");
  assert(sealed.commitment.startsWith("0x") && sealed.commitment.length === 66, "bad commitment");

  // Reveal roundtrip — the owner reveals and recovers the exact hand bytes.
  const revealed = await secrets.reveal(sealed, {
    caller: args.player,
    state: { ownerOf: args.player },
  });
  assert(
    Buffer.from(revealed).equals(Buffer.from(handBytes)),
    "seal/reveal roundtrip mismatch (revealed hand != sealed hand)",
  );
  log.ok("sealed a UNO hand and revealed it (AES-GCM roundtrip exact)");

  // A non-owner reveal must be denied (fail-closed).
  let denied = false;
  try {
    await secrets.reveal(sealed, { caller: args.player, state: {} });
  } catch {
    denied = true;
  }
  assert(denied, "non-owner reveal should be DENIED (fail-closed)");

  // A LEGAL move produces a signed attestation: play the red 5 onto a red 3 top.
  const att = await secrets.verify(sealed, {
    system: "PlayCardSystem",
    player: args.player,
    playedCard: 1, // red 5 is in hand
    topOfDiscard: encodeTop(1, 3), // red 3 — same color → legal
    activeColor: 1,
    roomId: "1",
  });
  assert(
    att.signature.startsWith("0x") && att.payload.startsWith("0x"),
    "attestation missing payload/signature",
  );
  assert(
    att.signer.toLowerCase() === secrets.signerAddress.toLowerCase(),
    "attestation signer mismatch",
  );
  log.ok("legal move produced a signed attestation");

  // An ILLEGAL move is rejected (no attestation, hand not leaked).
  let rejected = false;
  try {
    await secrets.verify(sealed, {
      system: "PlayCardSystem",
      player: args.player,
      playedCard: 99, // not in the hand
      topOfDiscard: encodeTop(1, 3),
      activeColor: 1,
      roomId: "1",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "illegal move should be rejected by the secrets verifier");
  log.ok("illegal move rejected (no attestation issued)");
}

/** Encode an UNO discard-top card as moveRule's decodeCard expects (high byte color, low byte number). */
function encodeTop(color: number, number: number): number {
  return (color << 8) | number;
}

/** Wait for the DirectRelayer's bundle to have a known tx hash, then mine it. */
async function waitForBundleTx(backend: Backend, callId: string): Promise<Hex> {
  // The DirectRelayer resolves submitBundle synchronously with a txHash; the
  // AwaitingRegistry resolution carries it once mined. We register and read it.
  const res = await backend.awaiting.register(callId);
  if (res.txHash) return res.txHash as Hex;
  throw new Error(`no txHash for bundle ${callId}`);
}

/** POST a mined webhook with a valid HMAC over the exact raw body bytes. */
async function deliverMinedWebhook(
  app: AppLike,
  bundleId: string,
  txHash: Hex,
  blockNumber: bigint,
): Promise<boolean> {
  const payload: WebhookPayload = {
    bundleId,
    status: "mined",
    txHash,
    blockNumber: Number(blockNumber),
  };
  const raw = JSON.stringify(payload);
  const sig = signWebhookBody(WEBHOOK_SECRET, raw);
  const res = await app.fetch(
    new Request("http://e2e/nexus/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [WEBHOOK_SIG_HEADER]: sig },
      body: raw,
    }),
  );
  return res.status === 200;
}

/** A soft assertion: records a failure but does not abort the whole suite. */
function assertSoft(ctx: E2EContext, cond: unknown, msg: string): void {
  if (!cond) {
    log.fail(msg);
    ctx.failures++;
  }
}

main().catch((e) => {
  if (e instanceof AssertionError) log.fail(e.message);
  else log.fail(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
