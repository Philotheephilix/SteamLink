import type { Hex, TokenSymbol } from "@nexus/types";

/**
 * The FacilitatorAdapter port — the x402 "seller" side of every `charge()`.
 *
 * `challenge()` is synchronous (no chain call): it assembles the 402 body and
 * mints a single-use nonce. `verify()` confirms a redemption settled on Base by
 * reading the receipt, and is idempotent on the redemption nonce so a
 * re-delivered webhook does not double-settle.
 *
 * The default `DelegationFacilitator` is *delegation-aware*: instead of a fresh
 * payment signature it accepts a redemption of the player's existing session
 * delegation, bounded by the budget caveats they approved once at `joinRoom()`.
 */
export interface FacilitatorAdapter {
  /**
   * Build the 402 body for a payment request. No *settlement* chain call — a
   * delegation-aware facilitator may resolve (cached) relayer capabilities to
   * derive the token address, so the return type permits a Promise.
   */
  challenge(req: PaymentRequest): Challenge402 | Promise<Challenge402>;
  /** Confirm a redemption settled on Base; idempotent on the redemption nonce. */
  verify(redemption: Redemption): Promise<Settlement>;
}

export interface PaymentRequest {
  /** Game/route the payment is for (advisory; used for logging/correlation). */
  game?: string;
  roomId?: string;
  /** Amount in human units, e.g. "5" — converted to smallest unit in the 402. */
  amount: string;
  /** Token symbol — validated against capabilities, resolved to an address. */
  token: TokenSymbol;
  /** Pot or seller — must be in the payer's AllowedTargets budget caveat. */
  recipient: Hex;
  reason?: string;
  /** The player's smart account (the budget delegator). */
  payer: Hex;
}

/** HTTP 402 body — the x402 challenge. `chain` is fixed to "base". */
export interface Challenge402 {
  scheme: "x402";
  /** Amount in the token's smallest unit (string, never a JS number). */
  price: string;
  /** ERC-20 address resolved from capabilities (never hardcoded). */
  token: Hex;
  tokenSymbol: TokenSymbol;
  recipient: Hex;
  chain: "base";
  /** Single-use nonce for replay protection (backend spec §8). */
  nonce: Hex;
  /** Epoch ms after which the nonce is invalid. */
  expiresAt: number;
  /** Identifies the delegation-redeeming facilitator. */
  facilitator: "nexus";
}

export interface Redemption {
  /** Echoes the Challenge402 nonce. */
  nonce: Hex;
  payer: Hex;
  /** The encoded session delegation + budget caveats to redeem. */
  delegationContext: Hex;
  /** Set once submitted to the relayer. */
  bundleId?: string;
  /** Set once mined (from the webhook). */
  txHash?: Hex;
}

export interface Settlement {
  nonce: Hex;
  txHash: Hex;
  blockNumber: number;
  /** Confirmed transferred amount (smallest unit). */
  amount: string;
  token: Hex;
  from: Hex;
  to: Hex;
  status: "settled";
}
