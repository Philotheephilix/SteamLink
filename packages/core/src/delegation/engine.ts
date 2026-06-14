/**
 * The Nexus delegation engine — the client-side core of the "one signature →
 * gasless everything" model. It (a) compiles a game's `delegation` config into
 * the two on-chain caveat groups (`buildGameplayCaveats` / `buildBudgetCaveats`),
 * (b) signs the single EIP-712 `GameDelegation` a player grants at joinRoom
 * (`signDelegation`, schema from ./eip712.ts, verified byte-for-byte against the
 * deployed NexusDelegationManager), and (c) packs the ERC-7579 executions and
 * `redeemDelegations` calldata (`buildMoveExecution`, `buildChargeExecution`,
 * `buildRedeemCalldata`) the relayer broadcasts on-chain.
 *
 * Position in the flow: the browser/bot calls `signDelegation` once; the backend
 * move/charge lifecycles call the `build*Execution`/`buildRedeemCalldata` helpers
 * to construct the bundle the RelayerAdapter submits to NexusDelegationManager.
 */
import type { Address, Hex } from "@nexus/types";
import {
  type LocalAccount,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  numberToHex,
  pad,
  parseAbiParameters,
  parseUnits,
} from "viem";
import { DELEGATION_TYPES, ROOT_AUTHORITY, eip712Domain } from "./eip712.js";
import type {
  Caveat,
  DeploymentAddresses,
  GameDelegationConfig,
  SignedDelegation,
  UnsignedDelegation,
} from "./types.js";

/** USDC has 6 decimals on Base. */
export function usdcToWei(amount: string): bigint {
  return parseUnits(amount, 6);
}

/** Solidity ABI fragment for the on-chain Delegation tuple (incl. signature). */
const DELEGATION_TUPLE = [
  {
    type: "tuple",
    name: "delegation",
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
] as const;

/** World.call(bytes32 systemId, bytes data) — the only system-dispatch entrypoint. */
const WORLD_ABI = [
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

/** NexusDelegationManager.redeemDelegations(bytes[],bytes32[],bytes[]). */
export const MANAGER_ABI = [
  {
    type: "function",
    name: "redeemDelegations",
    inputs: [
      { name: "permissionContexts", type: "bytes[]" },
      { name: "modes", type: "bytes32[]" },
      { name: "executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** Default single-execution ModeCode (the manager decodes the packed execution regardless). */
const SINGLE_EXECUTION_MODE = pad("0x00", { size: 32 }) as Hex;

// ── caveat builders ───────────────────────────────────────────────────────

function termsSystemAllowlist(world: Address, allowedSystems: Hex[]): Hex {
  return encodeAbiParameters(parseAbiParameters("address, bytes32[]"), [world, allowedSystems]);
}
function termsTimestamp(expiresAtMs: number): Hex {
  return encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(expiresAtMs)]);
}
function termsLimitedCalls(maxActions: number): Hex {
  return encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(maxActions)]);
}
function termsTurnBound(turnManager: Address, roomId: bigint): Hex {
  return encodeAbiParameters(parseAbiParameters("address, uint256"), [turnManager, roomId]);
}
function termsPerActionCap(token: Address, capWei: bigint): Hex {
  return encodeAbiParameters(parseAbiParameters("address, uint256"), [token, capWei]);
}
function termsErc20TransferAmount(token: Address, lifetimeCapWei: bigint): Hex {
  return encodeAbiParameters(parseAbiParameters("address, uint256"), [token, lifetimeCapWei]);
}
function termsAllowedRecipients(token: Address, recipients: Address[]): Hex {
  return encodeAbiParameters(parseAbiParameters("address, address[]"), [token, recipients]);
}

function caveat(enforcer: Address, terms: Hex): Caveat {
  return { enforcer, terms, args: "0x" };
}

/**
 * Compile the GameDelegation config's *gameplay* group into concrete caveats
 * for a given room. Order: allowlist, [turn], timestamp, [limit].
 */
export function buildGameplayCaveats(
  config: GameDelegationConfig,
  addrs: DeploymentAddresses,
  roomId: bigint,
): Caveat[] {
  const caveats: Caveat[] = [
    caveat(
      addrs.enforcers.systemAllowlist,
      termsSystemAllowlist(addrs.world, config.gameplay.allowedSystems),
    ),
  ];
  if (config.gameplay.turnBound) {
    caveats.push(caveat(addrs.enforcers.turnBound, termsTurnBound(addrs.turnManager, roomId)));
  }
  caveats.push(caveat(addrs.enforcers.timestamp, termsTimestamp(config.gameplay.expiresAt)));
  if (config.gameplay.maxActions !== undefined) {
    caveats.push(
      caveat(addrs.enforcers.limitedCalls, termsLimitedCalls(config.gameplay.maxActions)),
    );
  }
  return caveats;
}

/**
 * Compile the *budget* group into caveats: a per-action cap, a lifetime
 * (totalCap) cap, and a recipient allowlist. All three are emitted so a budget
 * delegation can never exceed the per-action spend, the lifetime spend, or pay
 * an unapproved recipient — closing the "per-action cap is unbounded in count"
 * gap. A totalCap of "0" means "no lifetime spend allowed" and is rejected.
 */
export function buildBudgetCaveats(
  config: GameDelegationConfig,
  addrs: DeploymentAddresses,
): Caveat[] {
  const { token, perActionCap, totalCap, allowedRecipients } = config.budget;
  if (token !== "USDC") throw new Error(`unsupported budget token: ${token}`);
  if (allowedRecipients.length === 0) {
    throw new Error("budget.allowedRecipients must be non-empty (no unrestricted spend)");
  }
  const caveats: Caveat[] = [
    caveat(addrs.enforcers.perActionCap, termsPerActionCap(addrs.usdc, usdcToWei(perActionCap))),
    caveat(
      addrs.enforcers.erc20TransferAmount,
      termsErc20TransferAmount(addrs.usdc, usdcToWei(totalCap)),
    ),
    caveat(
      addrs.enforcers.allowedRecipients,
      termsAllowedRecipients(addrs.usdc, allowedRecipients),
    ),
  ];
  return caveats;
}

/** Build the executionCalldata for a charge: USDC.transfer(recipient, amount). */
export function buildChargeExecution(
  addrs: DeploymentAddresses,
  recipient: Address,
  amount: string,
): Hex {
  const transfer = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "transfer",
    args: [recipient, usdcToWei(amount)],
  });
  return encodeExecution(addrs.usdc, 0n, transfer);
}

/**
 * Build the executionCalldata for a charge that moves the PAYER's funds:
 * USDC.transferFrom(from, recipient, amount). When redeemed through the manager,
 * the manager is `msg.sender` to the token, so `from` must have approved the
 * manager. This is the variant that actually debits the payer (unlike
 * `buildChargeExecution`, whose `transfer` would move the manager's own — zero —
 * balance).
 */
export function buildChargeFromExecution(
  addrs: DeploymentAddresses,
  from: Address,
  recipient: Address,
  amount: string,
): Hex {
  const transferFrom = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transferFrom",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "transferFrom",
    args: [from, recipient, usdcToWei(amount)],
  });
  return encodeExecution(addrs.usdc, 0n, transferFrom);
}

// ── signing & encoding ────────────────────────────────────────────────────

/**
 * The player signs ONE delegation (EIP-712). This is the single signature the
 * whole game hinges on. `delegate` is the redeemer (the relayer's address) — or
 * the zero address for "any redeemer".
 */
export async function signDelegation(
  player: LocalAccount,
  params: {
    chainId: number;
    delegationManager: Address;
    delegate: Address;
    caveats: Caveat[];
    salt?: bigint;
    /** Replay bound — how many redemptions this one signature authorizes. Default 1. */
    maxRedemptions?: bigint;
  },
): Promise<SignedDelegation> {
  const maxRedemptions = params.maxRedemptions ?? 1n;
  if (maxRedemptions <= 0n) throw new Error("maxRedemptions must be > 0");
  const unsigned: UnsignedDelegation = {
    delegate: params.delegate,
    delegator: player.address,
    authority: ROOT_AUTHORITY,
    caveats: params.caveats,
    salt: params.salt ?? 0n,
    maxRedemptions,
  };
  const signature = await player.signTypedData({
    domain: eip712Domain(params.chainId, params.delegationManager),
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message: unsigned,
  });
  return { ...unsigned, signature };
}

/** abi.encode(Delegation) — the permissionContext the manager decodes. */
export function encodePermissionContext(signed: SignedDelegation): Hex {
  return encodeAbiParameters(DELEGATION_TUPLE, [signed]);
}

/** ERC-7579 single-execution packing: target(20) ++ value(32) ++ callData. */
export function encodeExecution(target: Address, value: bigint, callData: Hex): Hex {
  return concatHex([target, pad(numberToHex(value), { size: 32 }), callData]);
}

/** Build the executionCalldata for a move: World.call(systemId, innerSystemCalldata). */
export function buildMoveExecution(
  addrs: DeploymentAddresses,
  systemId: Hex,
  innerSystemCalldata: Hex,
): Hex {
  const worldCall = encodeFunctionData({
    abi: WORLD_ABI,
    functionName: "call",
    args: [systemId, innerSystemCalldata],
  });
  return encodeExecution(addrs.world, 0n, worldCall);
}

/** Build the calldata for manager.redeemDelegations for a single redemption. */
export function buildRedeemCalldata(permissionContext: Hex, executionCalldata: Hex): Hex {
  return encodeFunctionData({
    abi: MANAGER_ABI,
    functionName: "redeemDelegations",
    args: [[permissionContext], [SINGLE_EXECUTION_MODE], [executionCalldata]],
  });
}
