/**
 * The canonical Nexus error surface. Every enforcer rejection, relayer failure,
 * or protocol violation surfaces as a typed NexusError so the UI can react
 * (e.g. show "out of budget" instead of a raw revert). Defined once here and
 * imported by every package.
 */

export const NEXUS_ERROR_CODES = [
  // ── delegation / enforcer rejections (on-chain) ──
  "NOT_YOUR_TURN", // TurnBoundEnforcer rejected
  "BUDGET_EXCEEDED", // PerActionCap / ERC20TransferAmount enforcer rejected
  "SYSTEM_NOT_ALLOWED", // SystemAllowlistEnforcer rejected
  "DELEGATION_EXPIRED", // TimestampEnforcer rejected — re-join required
  "ACTION_LIMIT_REACHED", // LimitedCallsEnforcer rejected
  "RECIPIENT_NOT_ALLOWED", // AllowedTargetsEnforcer rejected
  "ILLEGAL_MOVE", // Lit Action / system rule rejected the move

  // ── relayer / infrastructure ──
  "RELAYER_FAILED", // bundle failed; retryable
  "TARGET_MISMATCH", // delegation `to` != capabilities.targetAddress
  "CAPABILITIES_UNAVAILABLE", // relayer_getCapabilities failed
  "WEBHOOK_UNVERIFIED", // webhook signature/origin check failed

  // ── session / room ──
  "CAVEATS_INVALID", // joinRoom rejected a dangerously broad / incomplete delegation
  "SESSION_NOT_FOUND",
  "ROOM_CLOSED",

  // ── x402 / payment ──
  "PAYMENT_REQUIRED", // 402 issued
  "SETTLEMENT_FAILED", // verify() could not confirm settlement on Base
  "NONCE_REUSED", // replay protection tripped

  // ── secrets / randomness ──
  "REVEAL_DENIED", // Lit access conditions not met
  "SEAL_FAILED",
  "RNG_PENDING", // randomness requested but not yet fulfilled
  "ORDER_NOT_SEALED", // attempted to consume a deck whose seed was not sealed

  // ── generic ──
  "INVALID_CONFIG",
  "NOT_CONNECTED",
  "INTERNAL",
] as const;

export type NexusErrorCode = (typeof NEXUS_ERROR_CODES)[number];

export interface NexusErrorOptions {
  /** Underlying cause (a revert, an HTTP error, etc.). */
  cause?: unknown;
  /** Whether retrying the same operation may succeed. */
  retryable?: boolean;
  /** Arbitrary structured context for logging/telemetry. */
  context?: Record<string, unknown>;
  /** On-chain transaction hash, when the error originates from a mined revert. */
  txHash?: string;
}

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;
  readonly txHash?: string;

  constructor(code: NexusErrorCode, message: string, opts: NexusErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "NexusError";
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.context = opts.context;
    this.txHash = opts.txHash;
    Object.setPrototypeOf(this, NexusError.prototype);
  }

  static is(e: unknown): e is NexusError {
    return e instanceof NexusError;
  }

  /** Narrow to a specific code: `if (NexusError.has(e, "NOT_YOUR_TURN"))`. */
  static has(e: unknown, code: NexusErrorCode): e is NexusError {
    return e instanceof NexusError && e.code === code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      txHash: this.txHash,
      context: this.context,
    };
  }
}

const DEFAULT_RETRYABLE = new Set<NexusErrorCode>([
  "RELAYER_FAILED",
  "CAPABILITIES_UNAVAILABLE",
  "RNG_PENDING",
  "INTERNAL",
]);

/**
 * Map a known on-chain enforcer/revert signature to a NexusError code. Custom
 * enforcers revert with `CustomError()` selectors; the relayer/SDK decodes the
 * revert and routes it here. Unknown reverts fall back to INTERNAL.
 */
export function codeFromRevert(revert: string): NexusErrorCode {
  const r = revert.toLowerCase();
  if (r.includes("notyourturn") || r.includes("turnbound")) return "NOT_YOUR_TURN";
  if (r.includes("systemnotallowed") || r.includes("allowlist")) return "SYSTEM_NOT_ALLOWED";
  if (r.includes("expired") || r.includes("timestamp")) return "DELEGATION_EXPIRED";
  if (r.includes("limitedcalls") || r.includes("actionlimit")) return "ACTION_LIMIT_REACHED";
  if (r.includes("peractioncap") || r.includes("transferamount") || r.includes("budget"))
    return "BUDGET_EXCEEDED";
  if (r.includes("allowedtargets") || r.includes("recipient")) return "RECIPIENT_NOT_ALLOWED";
  if (r.includes("illegalmove")) return "ILLEGAL_MOVE";
  return "INTERNAL";
}
