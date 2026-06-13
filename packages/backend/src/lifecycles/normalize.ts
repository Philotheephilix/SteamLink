import type { SignedDelegation } from "../types.js";

/**
 * Coerce a signed delegation tuple's numeric fields back to `bigint`. A delegation
 * that crossed JSON (the real HTTP wire) carries `salt`/`maxRedemptions` as strings
 * or numbers — `encodeAbiParameters` (uint256) requires `bigint`. In-process callers
 * already pass `bigint`, for which this is an idempotent no-op. Hex/decimal strings
 * and numbers are accepted; anything unparseable throws.
 */
export function normalizeSignedDelegation(signed: SignedDelegation): SignedDelegation {
  return {
    ...signed,
    salt: toBigInt(signed.salt as unknown),
    maxRedemptions: toBigInt(signed.maxRedemptions as unknown),
  };
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new TypeError(`cannot coerce ${typeof v} to bigint`);
}
