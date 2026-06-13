/**
 * Branded primitive types. These are nominal at compile time but are plain
 * strings/bigints at runtime — zero overhead, just safety against mixing up an
 * address with an arbitrary hex string.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/**
 * Hex/Address/Bytes32 are template-literal types so they interoperate directly
 * with viem (whose `Hex`/`Address` are also `0x${string}`) — no casts at the
 * viem boundary. Runtime validators below still enforce the exact shapes.
 * TokenAmount stays nominally branded since it's a decimal string, not 0x-hex.
 */
export type Hex = `0x${string}`;
/** A 0x-prefixed 20-byte EVM address (not necessarily checksummed). */
export type Address = `0x${string}`;
/** A 0x-prefixed 32-byte value. */
export type Bytes32 = `0x${string}`;
/** A USDC/token amount expressed as a decimal string in human units, e.g. "5" or "0.02". */
export type TokenAmount = Brand<string, "TokenAmount">;

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function asHex(v: string): Hex {
  if (!HEX_RE.test(v)) throw new TypeError(`not a hex string: ${v}`);
  return v as Hex;
}

export function asAddress(v: string): Address {
  if (!ADDRESS_RE.test(v)) throw new TypeError(`not a 20-byte address: ${v}`);
  return v.toLowerCase() as Address;
}

export function isAddress(v: string): v is Address {
  return ADDRESS_RE.test(v);
}

export function asBytes32(v: string): Bytes32 {
  if (!BYTES32_RE.test(v)) throw new TypeError(`not a 32-byte value: ${v}`);
  return v as Bytes32;
}

export function asTokenAmount(v: string): TokenAmount {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new TypeError(`not a decimal amount: ${v}`);
  return v as TokenAmount;
}

export type TokenSymbol = "USDC";
