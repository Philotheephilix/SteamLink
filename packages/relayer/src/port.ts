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
}

export interface EncodedCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface BundleHandle {
  bundleId: string;
  /** Present once known (DirectRelayer knows immediately; OneShot via webhook). */
  txHash?: Hex;
}

export type BundleStatus = "pending" | "mined" | "failed";

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
