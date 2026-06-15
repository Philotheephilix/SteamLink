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
  buildBudgetCaveats,
  buildChargeFromExecution,
  buildGameplayCaveats,
  buildMoveExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  signDelegation,
  usdcToWei,
} from "@nexus/core";
import { DELEGATION_TYPES, eip712Domain } from "@nexus/core";
import { DirectRelayer, revertDataOf } from "@nexus/relayer";
import { type Address, CHAINS, type Hex } from "@nexus/types";
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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
  "RecipientNotAllowed",
  "ERC20TransferAmountExceeded",
  "InvalidDelegationSignature",
  "InvalidExecutionCalldata",
  "NonZeroValueUnsupported",
  "CounterGame_NotYourTurn",
  "CounterGame_Finished",
].map((name) => ({ type: "error", name, inputs: [] }) as const);

/** Minimal ERC-20 surface for the charge tests (approve + balance reads). */
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
          { name: "maxRedemptions", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getDelegationHash",
    stateMutability: "pure",
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
          { name: "maxRedemptions", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/** ERC20TransferAmountEnforcer.spentMap(manager, delegationHash) — cumulative spend.
 *  Keyed on the caller (the DelegationManager) since the C1 hardening, so a direct
 *  griefer can't pollute the manager's counter. */
const SPENT_MAP_ABI = [
  {
    type: "function",
    name: "spentMap",
    stateMutability: "view",
    inputs: [
      { name: "manager", type: "address" },
      { name: "delegationHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** TurnManager.startTurns — used to seat a fresh room for the self-contained game test. */
const TURN_MANAGER_ABI = [
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
  {
    type: "function",
    name: "getCurrent",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const TARGET_VALUE = 100n;

/**
 * Retry a happy-path on-chain op that is expected to SUCCEED, to absorb public
 * load-balanced-RPC eventual-consistency (a gas-estimation eth_call hitting a
 * node that hasn't yet seen a just-mined state change). Gas-estimation reverts
 * cost no gas, so retrying is free. Only used for ops we expect to succeed —
 * never for expected-revert assertions.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Only retry PRE-broadcast failures (gas-estimation reverts — the lag case),
      // identified by revert data. A post-broadcast timeout has no revert data and
      // must NOT be retried (the tx may have landed; re-redeeming could double-spend).
      const data = revertDataOf(e) ?? revertDataOf((e as { cause?: unknown })?.cause);
      const transient = data !== undefined || /execution reverted/i.test(String(e));
      if (!transient || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed: ${String(last)}`);
}

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

  /**
   * Submit a redemption and confirm it. Surfaces BOTH failure modes uniformly:
   * a pre-broadcast gas-estimation revert (thrown by submitBundle), and a
   * MINED revert (gas estimation passed against stale RPC state but the tx
   * reverted at mining) — recovered by re-simulating at the mined block so the
   * structural revert reason is available to decodeRevertName.
   */
  async function submitAndConfirm(data: Hex) {
    const handle = await relayer.submitBundle({
      encodedTxns: [{ to: addrs.delegationManager, data }],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash: handle.txHash! });
    if (receipt.status !== "success") {
      let revert: Hex | undefined;
      try {
        await pub.call({
          to: addrs.delegationManager,
          data,
          account: relayerWallet.account,
          blockNumber: receipt.blockNumber,
        });
      } catch (e) {
        revert = revertDataOf(e) ?? revertDataOf((e as { cause?: unknown })?.cause);
      }
      const err = new Error(
        `redemption reverted on-chain${revert ? ` [revert ${revert}]` : ""}`,
      ) as Error & { data?: Hex };
      if (revert) err.data = revert;
      throw err;
    }
    return receipt;
  }

  const future = Date.now() + 3 * 3600_000;
  const player2 = privateKeyToAccount(t.player2.key);

  async function redeemMove(
    cfg: GameDelegationConfig,
    salt = 0n,
    signer = player,
    target = TARGET_VALUE,
    roomId = d.roomId,
  ) {
    const caveats = buildGameplayCaveats(cfg, addrs, roomId);
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
      args: [roomId, target],
    });
    const exec = buildMoveExecution(addrs, d.counterGameSystemId, move);
    const data = buildRedeemCalldata(ctx, exec);
    return submitAndConfirm(data);
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
        maxRedemptions: signed.maxRedemptions,
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
    const receipt = await withRetry(
      () => redeemMove(configFor(d.counterGameSystemId, future)),
      "TEST1 move",
    );
    const playerAfter = await pub.getBalance({ address: player.address });
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
    // Gasless proof from the receipt (robust to public-RPC balance-read lag): the
    // player never submitted a tx (balance unchanged) and the RELAYER is the tx
    // sender who paid real gas.
    assert(playerBefore === playerAfter, "player paid ZERO gas (balance unchanged)");
    assert(
      receipt.from.toLowerCase() === t.relayer.address.toLowerCase(),
      `redemption tx submitted by ${receipt.from}, expected relayer ${t.relayer.address}`,
    );
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    assert(gasPaid > 0n, "relayer paid real gas for the redemption");
    log.ok(
      `move landed: counter=1, _msgSender=player, player spent 0, relayer (tx.from) paid ${gasPaid} wei gas — tx ${receipt.transactionHash}`,
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

  // TEST 5 — a FULL multi-player game played gaslessly to a win, in a FRESH room
  // (self-contained: it seats its own room rather than depending on state left by
  // earlier tests). The relayer (authorized on the TurnManager) seats room d.roomId+1
  // with order [player, player2]; with target 2: player1→1 (advance), player2→2 (win).
  log.step("TEST 5 — full multi-player game to a win in a fresh room (both players gasless)");
  {
    const roomId2 = d.roomId + 1n;
    const seatHash = await relayerWallet.writeContract({
      address: addrs.turnManager,
      abi: TURN_MANAGER_ABI,
      functionName: "startTurns",
      args: [roomId2, [player.address, player2.address], 5000n],
    });
    await pub.waitForTransactionReceipt({ hash: seatHash });
    // Read-after-write: on a load-balanced public RPC the seated turn can lag.
    // Poll getCurrent until it reflects the seat before redeeming (else the move's
    // gas-estimation eth_call may hit a stale node and revert NotYourTurn).
    for (let i = 0; i < 20; i++) {
      const cur = await pub.readContract({
        address: addrs.turnManager,
        abi: TURN_MANAGER_ABI,
        functionName: "getCurrent",
        args: [roomId2],
      });
      if (cur.toLowerCase() === player.address.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const cfg = configFor(d.counterGameSystemId, future);
    const p1Before = await pub.getBalance({ address: player.address });
    const p2Before = await pub.getBalance({ address: player2.address });

    await withRetry(() => redeemMove(cfg, 50n, player, 2n, roomId2), "TEST5 p1 move");
    const winReceipt = await withRetry(
      () => redeemMove(cfg, 51n, player2, 2n, roomId2),
      "TEST5 p2 move",
    ); // player2: 1 -> 2, wins

    const won = parseEventLogs({
      abi: COUNTER_ABI,
      eventName: "CounterGame_Won",
      logs: winReceipt.logs,
    });
    assert(won.length === 1, "expected a CounterGame_Won event");
    assert(
      won[0]!.args.winner.toLowerCase() === player2.address.toLowerCase(),
      `winner ${won[0]!.args.winner}, expected player2 ${player2.address}`,
    );
    const p1After = await pub.getBalance({ address: player.address });
    const p2After = await pub.getBalance({ address: player2.address });
    assert(
      p1Before === p1After && p2Before === p2After,
      "both players paid ZERO gas across the game",
    );
    log.ok("game played to completion gaslessly — player2 won, both players spent 0 gas");
  }

  // ── x402 LIVE budget-enforcement charge tests (TEST 6–9) ───────────────────
  // Real USDC moves bounded by the delegation: per-action cap, recipient
  // allowlist, lifetime cap. The PAYER is the relayer/funded account (on Base
  // Sepolia only that key holds USDC); the token is TestUSDC on anvil, canonical
  // USDC on Base. A charge-specific DeploymentAddresses points the engine at the
  // right token so caveats + transferFrom target it.
  // On a live chain use the CANONICAL USDC (addrs.usdc is 0x0 — the counter game
  // doesn't use a token); on a local chain use the deployed TestUSDC.
  const canonicalUsdc =
    t.chainId === 84532
      ? (CHAINS["base-sepolia"].usdc as Address)
      : t.chainId === 8453
        ? (CHAINS.base.usdc as Address)
        : undefined;
  const usdcForCharge: Address = canonicalUsdc ?? d.testUsdc;
  const chargeAddrs: DeploymentAddresses = { ...addrs, usdc: usdcForCharge };
  const payer = privateKeyToAccount(t.relayer.key); // the funded account holding USDC
  const pot = d.pot;

  // Build & redeem a transferFrom charge through the manager (relayer submits).
  async function redeemCharge(opts: {
    recipient: Address;
    amount: string;
    perActionCap: string;
    totalCap: string;
    allowedRecipients: Address[];
    salt: bigint;
    maxRedemptions: bigint;
    signed?: import("@nexus/core").SignedDelegation;
  }) {
    let signed = opts.signed;
    if (!signed) {
      const caveats = buildBudgetCaveats(
        {
          gameplay: { allowedSystems: [], expiresAt: future },
          budget: {
            token: "USDC",
            perActionCap: opts.perActionCap,
            totalCap: opts.totalCap,
            allowedRecipients: opts.allowedRecipients,
          },
        },
        chargeAddrs,
      );
      signed = await signDelegation(payer, {
        chainId: t.chainId,
        delegationManager: addrs.delegationManager,
        delegate: t.relayer.address,
        caveats,
        salt: opts.salt,
        maxRedemptions: opts.maxRedemptions,
      });
    }
    const ctx = encodePermissionContext(signed);
    const exec = buildChargeFromExecution(chargeAddrs, payer.address, opts.recipient, opts.amount);
    const data = buildRedeemCalldata(ctx, exec);
    const receipt = await submitAndConfirm(data);
    return { receipt, signed };
  }

  const readBal = (account: Address) =>
    pub.readContract({
      address: usdcForCharge,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });

  log.step("Charge setup — payer approves the manager to spend USDC (one real tx)");
  {
    const approveHash = await relayerWallet.writeContract({
      address: usdcForCharge,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [addrs.delegationManager, usdcToWei("1000")],
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
    log.ok(`payer ${payer.address} approved manager for USDC (${usdcForCharge})`);
  }

  // TEST 6 — gasless charge bounded by the delegation: a "1" USDC transferFrom
  // succeeds within per-action cap "5" / lifetime cap "10" to the allowed pot.
  log.step("TEST 6 — charge succeeds, bounded by the delegation (real USDC moves)");
  {
    const { receipt } = await withRetry(
      () =>
        redeemCharge({
          recipient: pot,
          amount: "0.1",
          perActionCap: "0.5",
          totalCap: "1",
          allowedRecipients: [pot],
          salt: 600n,
          maxRedemptions: 5n,
        }),
      "TEST6 charge",
    );
    // Verify via the USDC Transfer event in the receipt (definitive; immune to
    // public-RPC balance-read lag).
    const transfers = parseEventLogs({ abi: ERC20_ABI, eventName: "Transfer", logs: receipt.logs });
    const xfer = transfers.find((x) => x.address.toLowerCase() === usdcForCharge.toLowerCase());
    assert(xfer !== undefined, "expected a USDC Transfer event in the charge receipt");
    assert(
      xfer.args.from.toLowerCase() === payer.address.toLowerCase() &&
        xfer.args.to.toLowerCase() === pot.toLowerCase() &&
        xfer.args.value === 100_000n,
      `expected Transfer(payer→pot, 0.1 USDC), got ${xfer.args.from}→${xfer.args.to} ${xfer.args.value}`,
    );
    log.ok(
      "charge landed: USDC Transfer(payer→pot, 0.1) — bounded by per-action/lifetime/recipient caveats",
    );
  }

  async function expectChargeRevert(
    name: string,
    opts: Parameters<typeof redeemCharge>[0],
    expectedError: string,
  ) {
    try {
      await redeemCharge(opts);
      log.fail(`${name}: expected revert ${expectedError} but charge succeeded`);
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

  // TEST 7 — recipient allowlist: a charge to a non-allowed (attacker) address
  // with allowedRecipients=[pot] is rejected by AllowedRecipientsEnforcer.
  log.step("TEST 7 — recipient allowlist rejects a charge to a non-allowed address");
  {
    const attacker = privateKeyToAccount(generatePrivateKey()).address as Address;
    await expectChargeRevert(
      "RecipientAllowlist",
      {
        recipient: attacker,
        amount: "1",
        perActionCap: "5",
        totalCap: "10",
        allowedRecipients: [pot],
        salt: 700n,
        maxRedemptions: 1n,
      },
      "RecipientNotAllowed",
    );
  }

  // TEST 8 — per-action cap: a single charge of "6" exceeds perActionCap "5".
  log.step("TEST 8 — per-action cap rejects a single charge above the cap");
  await expectChargeRevert(
    "PerActionCap",
    {
      recipient: pot,
      amount: "6",
      perActionCap: "5",
      totalCap: "100",
      allowedRecipients: [pot],
      salt: 800n,
      maxRedemptions: 1n,
    },
    "PerActionCapExceeded",
  );

  // TEST 9 — lifetime cap: reuse ONE signed delegation (totalCap "10", per-action
  // "5") and redeem repeated "4" charges; ERC20TransferAmount accumulates on the
  // delegationHash until a redemption pushes the cumulative spend past 10.
  log.step("TEST 9 — lifetime cap rejects the redemption that crosses totalCap");
  {
    // 0.4 + 0.4 = 0.8 (ok), third 0.4 → 1.2 > totalCap 1 → must revert.
    const r1 = await withRetry(
      () =>
        redeemCharge({
          recipient: pot,
          amount: "0.4",
          perActionCap: "0.5",
          totalCap: "1",
          allowedRecipients: [pot],
          salt: 900n,
          maxRedemptions: 5n,
        }),
      "TEST9 charge 1",
    );
    const signed = r1.signed;
    const delegationHash = (await pub.readContract({
      address: addrs.delegationManager,
      abi: MANAGER_VIEW_ABI,
      functionName: "getDelegationHash",
      args: [signed],
    })) as Hex;
    // Poll the enforcer's cumulative spend until it reflects the expected value,
    // so the NEXT charge's gas-estimation sees fresh state (deterministic revert).
    const waitSpent = async (expected: bigint) => {
      for (let i = 0; i < 20; i++) {
        const spent = await pub.readContract({
          address: addrs.enforcers.erc20TransferAmount,
          abi: SPENT_MAP_ABI,
          functionName: "spentMap",
          args: [addrs.delegationManager, delegationHash],
        });
        if (spent >= expected) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    await waitSpent(400_000n);

    await withRetry(
      () =>
        redeemCharge({
          recipient: pot,
          amount: "0.4",
          perActionCap: "0.5",
          totalCap: "1",
          allowedRecipients: [pot],
          salt: 900n,
          maxRedemptions: 5n,
          signed,
        }),
      "TEST9 charge 2",
    );
    await waitSpent(800_000n);

    await expectChargeRevert(
      "Lifetime",
      {
        recipient: pot,
        amount: "0.4",
        perActionCap: "0.5",
        totalCap: "1",
        allowedRecipients: [pot],
        salt: 900n,
        maxRedemptions: 5n,
        signed,
      },
      "ERC20TransferAmountExceeded",
    );
  }

  log.title(
    failures === 0 ? `${t.label}: ALL LIVE TESTS PASSED` : `${t.label}: ${failures} FAILED`,
  );
  return failures;
}
