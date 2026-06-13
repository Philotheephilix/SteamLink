/**
 * The Nexus zero-mock integration suite, parameterized by target chain. The same
 * code runs against a local anvil chain (no funding needed) and against Base
 * Sepolia / Base mainnet (needs a funded relayer key). Everything here is real:
 * real contracts deployed on the target, real EIP-712 signatures, real on-chain
 * caveat enforcement. No mocks.
 */
import {
  type DeploymentAddresses,
  type GameDelegationConfig,
  buildGameplayCaveats,
  buildMoveExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  signDelegation,
} from "@nexus/core";
import { DELEGATION_TYPES, eip712Domain } from "@nexus/core";
import { DirectRelayer, revertDataOf } from "@nexus/relayer";
import type { Address, Hex } from "@nexus/types";
import {
  http,
  type Chain,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  hashTypedData,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type DeployedNexus, deployNexus } from "../lib/deploy.js";
import { assert, log } from "../lib/log.js";

export interface IntegrationTarget {
  label: string;
  chain: Chain;
  rpcUrl: string;
  chainId: number;
  /** Funded account — deploys, pays gas, redeems on the player's behalf. */
  relayer: { key: Hex; address: Address };
  /** The player — signs ONE delegation, never pays gas, needs no funding. */
  player: { key: Hex; address: Address };
  /** A second seat; also signs its own delegations for the full game-to-win test. */
  player2: { key: Hex; address: Address };
}

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
  {
    type: "event",
    name: "CounterGame_Won",
    inputs: [
      { name: "roomId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
    ],
  },
] as const;

/** All Nexus custom errors, for structural revert decoding (no brittle substring matching). */
const NEXUS_ERRORS_ABI = [
  "SystemNotAllowed",
  "DelegationExpired",
  "NotYourTurn",
  "ActionLimitReached",
  "PerActionCapExceeded",
  "InvalidDelegationSignature",
  "InvalidExecutionCalldata",
  "NonZeroValueUnsupported",
  "CounterGame_NotYourTurn",
  "CounterGame_Finished",
].map((name) => ({ type: "error", name, inputs: [] }) as const);

/** Manager view helpers used to cross-check the TS EIP-712 encoding against the chain. */
const MANAGER_VIEW_ABI = [
  {
    type: "function",
    name: "getTypedDataDigest",
    stateMutability: "view",
    inputs: [
      {
        name: "delegation",
        type: "tuple",
        components: [
          { name: "delegate", type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          {
            name: "caveats",
            type: "tuple[]",
            components: [
              { name: "enforcer", type: "address" },
              { name: "terms", type: "bytes" },
              { name: "args", type: "bytes" },
            ],
          },
          { name: "salt", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const TARGET_VALUE = 100n;

/** Decode a thrown redemption error into a custom-error name, structurally. */
function decodeRevertName(err: unknown): string | undefined {
  const data = revertDataOf(err) ?? revertDataOf((err as { cause?: unknown })?.cause);
  if (!data) return undefined;
  try {
    return decodeErrorResult({ abi: NEXUS_ERRORS_ABI, data }).errorName;
  } catch {
    return undefined;
  }
}

function configFor(systemId: Hex, expiresAt: number, turnBound = true): GameDelegationConfig {
  return {
    gameplay: { allowedSystems: [systemId], turnBound, expiresAt, maxActions: 100 },
    budget: { token: "USDC", totalCap: "0", perActionCap: "0", allowedRecipients: [] },
  };
}

/** Run the full suite against a target. Returns the number of failed assertions. */
export async function runIntegration(t: IntegrationTarget): Promise<number> {
  log.title(`Nexus LIVE integration — ${t.label} (zero mocks)`);
  let failures = 0;

  const pub = createPublicClient({ chain: t.chain, transport: http(t.rpcUrl) });

  log.step("Deploying World + DelegationManager + game + enforcers on-chain…");
  const d: DeployedNexus = deployNexus({
    rpcUrl: t.rpcUrl,
    deployerKey: t.relayer.key,
    player: t.player.address,
    player2: t.player2.address,
    roomId: 1n,
    chainId: t.chainId,
  });
  log.ok(`World ${d.world}`);
  log.ok(`DelegationManager ${d.delegationManager}`);

  const addrs: DeploymentAddresses = d;
  const player = privateKeyToAccount(t.player.key);
  const relayerWallet = createWalletClient({
    account: privateKeyToAccount(t.relayer.key),
    chain: t.chain,
    transport: http(t.rpcUrl),
  });
  const relayer = new DirectRelayer({ wallet: relayerWallet, publicClient: pub, usdc: addrs.usdc });

  const future = Date.now() + 3 * 3600_000;
  const player2 = privateKeyToAccount(t.player2.key);

  async function redeemMove(
    cfg: GameDelegationConfig,
    salt = 0n,
    signer = player,
    target = TARGET_VALUE,
  ) {
    const caveats = buildGameplayCaveats(cfg, addrs, d.roomId);
    const signed = await signDelegation(signer, {
      chainId: t.chainId,
      delegationManager: addrs.delegationManager,
      delegate: t.relayer.address,
      caveats,
      salt,
    });
    const ctx = encodePermissionContext(signed);
    const move = encodeFunctionData({
      abi: COUNTER_ABI,
      functionName: "increment",
      args: [d.roomId, target],
    });
    const exec = buildMoveExecution(addrs, d.counterGameSystemId, move);
    const data = buildRedeemCalldata(ctx, exec);
    const handle = await relayer.submitBundle({
      encodedTxns: [{ to: addrs.delegationManager, data }],
    });
    return pub.waitForTransactionReceipt({ hash: handle.txHash! });
  }

  // TEST 0 — EIP-712 cross-check: the TS encoding MUST match the on-chain manager
  // exactly, or every live redemption would silently revert. Uses a multi-caveat
  // delegation with non-empty terms.
  log.step("TEST 0 — EIP-712 digest cross-check (TS encoding == on-chain manager)");
  {
    const caveats = buildGameplayCaveats(configFor(d.counterGameSystemId, future), addrs, d.roomId);
    const signed = await signDelegation(player, {
      chainId: t.chainId,
      delegationManager: addrs.delegationManager,
      delegate: t.relayer.address,
      caveats,
      salt: 7n,
    });
    const tsDigest = hashTypedData({
      domain: eip712Domain(t.chainId, addrs.delegationManager),
      types: DELEGATION_TYPES,
      primaryType: "Delegation",
      message: {
        delegate: signed.delegate,
        delegator: signed.delegator,
        authority: signed.authority,
        caveats: signed.caveats,
        salt: signed.salt,
      },
    });
    const onchainDigest = await pub.readContract({
      address: addrs.delegationManager,
      abi: MANAGER_VIEW_ABI,
      functionName: "getTypedDataDigest",
      args: [signed],
    });
    assert(
      tsDigest.toLowerCase() === onchainDigest.toLowerCase(),
      `EIP-712 digest mismatch: ts=${tsDigest} chain=${onchainDigest}`,
    );
    log.ok(`digests match (${tsDigest.slice(0, 18)}…) — TS and contract agree`);
  }

  // TEST 1 — one signature, gasless move
  log.step("TEST 1 — one signature, gasless move redeemed by relayer");
  {
    const playerBefore = await pub.getBalance({ address: player.address });
    const relayerBefore = await pub.getBalance({ address: t.relayer.address });
    const receipt = await redeemMove(configFor(d.counterGameSystemId, future));
    const playerAfter = await pub.getBalance({ address: player.address });
    const relayerAfter = await pub.getBalance({ address: t.relayer.address });
    const moved = parseEventLogs({
      abi: COUNTER_ABI,
      eventName: "CounterGame_Moved",
      logs: receipt.logs,
    });
    assert(moved.length === 1, "expected one CounterGame_Moved event");
    assert(
      moved[0]!.args.player.toLowerCase() === player.address.toLowerCase(),
      `move attributed to ${moved[0]!.args.player}, expected ${player.address}`,
    );
    assert(moved[0]!.args.value === 1n, "counter should be 1 after first move");
    assert(playerBefore === playerAfter, "player paid ZERO gas (balance unchanged)");
    assert(relayerAfter < relayerBefore, "relayer actually paid the gas (balance decreased)");
    log.ok(
      `move landed: counter=1, _msgSender=player, player spent 0, relayer paid ${relayerBefore - relayerAfter} wei`,
    );
  }

  async function expectRevert(
    name: string,
    cfg: GameDelegationConfig,
    expectedError: string,
    salt: bigint,
  ) {
    try {
      await redeemMove(cfg, salt);
      log.fail(`${name}: expected revert ${expectedError} but redemption succeeded`);
      failures++;
    } catch (e) {
      const decoded = decodeRevertName(e);
      if (decoded === expectedError) {
        log.ok(`${name}: rejected on-chain with ${expectedError}() — decoded structurally`);
      } else {
        log.fail(
          `${name}: reverted but decoded as ${decoded ?? "<undecodable>"}, expected ${expectedError}`,
        );
        failures++;
      }
    }
  }

  log.step("TEST 2 — SystemAllowlistEnforcer rejects a non-allowed system");
  await expectRevert(
    "SystemAllowlist",
    configFor(`0x${"ab".repeat(32)}` as Hex, future),
    "SystemNotAllowed",
    2n,
  );

  log.step("TEST 3 — TimestampEnforcer rejects an expired delegation");
  await expectRevert(
    "Timestamp",
    configFor(d.counterGameSystemId, Date.now() - 3600_000, false),
    "DelegationExpired",
    3n,
  );

  log.step("TEST 4 — TurnBoundEnforcer rejects a move out of turn");
  await expectRevert("TurnBound", configFor(d.counterGameSystemId, future), "NotYourTurn", 4n);

  // TEST 5 — a FULL multi-player game played gaslessly to a win. After TEST 1 the
  // counter is 1 and it is player2's turn. With target 3: player2→2, player1→3 wins.
  // Both players sign their own delegations; the relayer redeems both. Neither pays gas.
  log.step("TEST 5 — full multi-player game to a win (both players gasless)");
  {
    const cfg = configFor(d.counterGameSystemId, future);
    const p1Before = await pub.getBalance({ address: player.address });
    const p2Before = await pub.getBalance({ address: player2.address });

    await redeemMove(cfg, 50n, player2, 3n); // player2: counter 1 -> 2
    const winReceipt = await redeemMove(cfg, 51n, player, 3n); // player1: counter 2 -> 3, wins

    const won = parseEventLogs({
      abi: COUNTER_ABI,
      eventName: "CounterGame_Won",
      logs: winReceipt.logs,
    });
    assert(won.length === 1, "expected a CounterGame_Won event");
    assert(
      won[0]!.args.winner.toLowerCase() === player.address.toLowerCase(),
      `winner ${won[0]!.args.winner}, expected player1 ${player.address}`,
    );
    const p1After = await pub.getBalance({ address: player.address });
    const p2After = await pub.getBalance({ address: player2.address });
    assert(
      p1Before === p1After && p2Before === p2After,
      "both players paid ZERO gas across the game",
    );
    log.ok("game played to completion gaslessly — player1 won, both players spent 0 gas");
  }

  log.title(
    failures === 0 ? `${t.label}: ALL LIVE TESTS PASSED` : `${t.label}: ${failures} FAILED`,
  );
  return failures;
}
