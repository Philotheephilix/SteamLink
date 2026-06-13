import type { Address } from "@nexus/types";

/**
 * The EIP-712 schema for a Nexus GameDelegation. This MUST match
 * NexusDelegationManager.sol byte-for-byte (domain, type order, field order),
 * or on-chain signature recovery fails. Verified live against the deployed
 * manager's getDelegationHash() / domainSeparator() in the scripts/ suite.
 */

export const EIP712_DOMAIN_NAME = "Nexus Game Delegation";
export const EIP712_DOMAIN_VERSION = "1";

/** Root authority (a non-chained, root delegation). */
export const ROOT_AUTHORITY =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** viem typed-data `types` for a Delegation. Field order is significant. */
export const DELEGATION_TYPES = {
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
    { name: "args", type: "bytes" },
  ],
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
    { name: "maxRedemptions", type: "uint256" },
  ],
} as const;

export function eip712Domain(chainId: number, verifyingContract: Address) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}
