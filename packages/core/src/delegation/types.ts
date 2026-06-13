import type { Address, Hex } from "@nexus/types";

/** A single on-chain caveat: an enforcer plus its encoded terms/args. */
export interface Caveat {
  enforcer: Address;
  terms: Hex;
  args: Hex;
}

/** The unsigned delegation tuple (matches the Solidity struct sans signature). */
export interface UnsignedDelegation {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: bigint;
  /** How many times this signed delegation may be redeemed (replay bound). */
  maxRedemptions: bigint;
}

/** A delegation with the player's EIP-712 signature attached. */
export interface SignedDelegation extends UnsignedDelegation {
  signature: Hex;
}

/**
 * The developer-facing GameDelegation config — the two caveat groups from the
 * design (gameplay + budget). The engine compiles this into concrete Caveats
 * pointing at deployed enforcer addresses.
 */
export interface GameDelegationConfig {
  gameplay: {
    /** system ids (bytes32) the delegation may dispatch to. */
    allowedSystems: Hex[];
    /** restrict to the player's turn (TurnBoundEnforcer). */
    turnBound?: boolean;
    /** epoch ms after which the delegation is invalid (TimestampEnforcer). */
    expiresAt: number;
    /** cap on number of redemptions (LimitedCallsEnforcer). */
    maxActions?: number;
  };
  budget: {
    token: "USDC";
    /** lifetime spend cap, human units (ERC20 transfer-amount enforcer upstream). */
    totalCap: string;
    /** per-redemption spend cap (PerActionCapEnforcer). */
    perActionCap: string;
    /** recipients the spend may target (pots, sellers). */
    allowedRecipients: Address[];
  };
}

/** Deployed enforcer + infra addresses the engine needs to compile caveats. */
export interface DeploymentAddresses {
  world: Address;
  delegationManager: Address;
  turnManager: Address;
  usdc: Address;
  enforcers: {
    turnBound: Address;
    systemAllowlist: Address;
    timestamp: Address;
    limitedCalls: Address;
    perActionCap: Address;
    /** lifetime cumulative spend cap (budget.totalCap). */
    erc20TransferAmount: Address;
    /** transfer-recipient allowlist (budget.allowedRecipients). */
    allowedRecipients: Address;
  };
}
