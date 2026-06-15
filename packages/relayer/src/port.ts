import type { Address, Hex } from "@nexus/types";

/**
 * The RelayerAdapter port. Every redemption — gameplay move or payment — reaches
 * the chain through this single interface. The default live implementation is
 * `DirectRelayer` (self-relay via a funded key); `OneShotRelayer` is the
 * production permissionless-relayer adapter (gas in stablecoin, EOA 7702 upgrades).
 */

export interface RelayerCapabilities {
  /** Chains the relayer serves. Nexus is Base-only, so this is ["base"] or ["base-sepolia"]. */
  chains: string[];
  /** Accepted payment/fee tokens, by symbol -> address. Never hardcode; read from here. */
  tokens: Record<string, Address>;
  /** Address that collects relay fees. */
  feeCollector: Address;
  /**
   * The address redemptions must be addressed `to`. The delegation's `to`/delegate
   * MUST equal this or submission is rejected before broadcast.
   */
  targetAddress: Address;
}

/** A bundle to relay: a redemption context plus the encoded calls to execute. */
export interface Bundle {
  /** ABI-encoded delegation permission context(s) for redemption, when relaying a redemption. */
  delegationContext?: Hex;
  /** The encoded transactions to execute (to/data/value triples, abi-encoded by the caller). */
  encodedTxns: EncodedCall[];
  /** Optional EIP-7702 authorization to upgrade an EOA in the same bundle. */
  eip7702Auth?: Hex;
  /** Where the relayer should POST terminal status (webhook). */
  destinationUrl?: string;
  /**
   * Marks a MONEY bundle (pot settle/refund, charge). When true, the relayer MUST
   * be able to determine the delegation target and assert it equals
   * `capabilities.targetAddress`; if the target cannot be determined the bundle is
   * HARD-REJECTED rather than submitted with the guard skipped (H4).
   */
  requireTarget?: boolean;
  /**
   * Deterministic idempotency key (e.g. `pot:<room>:refund:<recipient>:<round>`).
   * The relayer dedupes by this key so a retried submit cannot double-pay (H4).
   * On the 1Shot public relayer this becomes the bundle `taskId`.
   */
  idempotencyKey?: string;
  /**
   * Structured ERC-7710 permission context (the signed delegation chain) for the
   * 1Shot public relayer's `relayer_send7710Transaction`. When present the adapter
   * relays this chain plus `encodedTxns` (mapped to executions) directly; the
   * single abi-encoded `delegationContext` Hex is the legacy REST shape.
   */
  permissionContext?: readonly RelayDelegation[];
  /** Optional EIP-7702 authorizations folded into the same relayed bundle. */
  authorizationList?: readonly SignedAuthorization7702[];
}

export interface EncodedCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** An ERC-7710 caveat as the 1Shot public relayer expects it on the wire. */
export interface RelayCaveat {
  enforcer: Address;
  terms: Hex;
  args: Hex;
}

/**
 * A signed ERC-7710 delegation in a relayer `permissionContext`. The `delegate`
 * is who may redeem (the relayer's `targetAddress`); the `delegator` is the
 * player who signed once at `joinRoom()`.
 */
export interface RelayDelegation {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: RelayCaveat[];
  salt: Hex;
  signature: Hex;
}

/** An EIP-7702 signed authorization tuple, folded inline into a relayed bundle. */
export interface SignedAuthorization7702 {
  address: Address;
  chainId: number | string;
  nonce: number | string;
  r: Hex;
  s: Hex;
  yParity: number | string;
}

export interface BundleHandle {
  bundleId: string;
  /** Present once known (DirectRelayer knows immediately; OneShot via webhook). */
  txHash?: Hex;
}

/**
 * Bundle lifecycle status. `pending` is non-terminal (submitted, not yet on-chain);
 * `mined` and `failed` are terminal. The hot path resolves on the terminal events
 * delivered via {@link RelayerAdapter.onStatus} (webhook-driven for OneShot).
 */
export type BundleStatus = "pending" | "mined" | "failed";

/** A terminal (or progress) status update for one bundle, keyed by `bundleId`. */
export interface StatusEvent {
  bundleId: string;
  status: BundleStatus;
  txHash?: Hex;
  blockNumber?: bigint;
  /** Decoded revert reason when status === "failed". */
  revert?: string;
}

export type Unsubscribe = () => void;

export interface Eip7702Authorization {
  /** The EOA being upgraded. */
  account: Address;
  /** The smart-account implementation to delegate code to. */
  implementation: Address;
  /** Signed authorization tuple, abi-encoded. */
  signedAuth: Hex;
}

export interface UpgradeResult {
  account: Address;
  txHash: Hex;
}

export interface RelayerAdapter {
  /** Resolve and cache capabilities. The source of truth for tokens + targetAddress. */
  getCapabilities(): Promise<RelayerCapabilities>;
  /** Submit a bundle for relaying. Resolves when accepted (not necessarily mined). */
  submitBundle(bundle: Bundle): Promise<BundleHandle>;
  /** Subscribe to terminal status for all bundles. */
  onStatus(cb: (e: StatusEvent) => void): Unsubscribe;
  /** Upgrade an EOA to a smart account in place (same address) via EIP-7702. */
  upgradeEOA(auth: Eip7702Authorization): Promise<UpgradeResult>;
}
