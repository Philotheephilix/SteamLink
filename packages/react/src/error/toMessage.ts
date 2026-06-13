import type { NexusError, NexusErrorCode } from "@nexus/types";

interface Copy {
  title: string;
  hint?: string;
  retryable: boolean;
}

/**
 * Central copy table: every NexusErrorCode maps to UI text. The `Record` type
 * makes this exhaustive — adding a code to the enum breaks the build until it is
 * given copy here. Components call `toMessage`/`errorMeta`; never inspect reverts.
 */
const COPY: Record<NexusErrorCode, Copy> = {
  NOT_YOUR_TURN: { title: "Not your turn yet", retryable: false },
  BUDGET_EXCEEDED: {
    title: "Out of budget",
    hint: "Raise your spend cap to continue.",
    retryable: false,
  },
  SYSTEM_NOT_ALLOWED: { title: "Action not permitted in this session", retryable: false },
  DELEGATION_EXPIRED: { title: "Session expired", hint: "Re-join the room.", retryable: true },
  ACTION_LIMIT_REACHED: { title: "Action limit reached for this session", retryable: false },
  RECIPIENT_NOT_ALLOWED: { title: "That recipient isn't permitted", retryable: false },
  ILLEGAL_MOVE: { title: "That move isn't legal", retryable: false },
  RELAYER_FAILED: { title: "Network hiccup", hint: "Tap to retry.", retryable: true },
  TARGET_MISMATCH: { title: "Session target mismatch", retryable: false },
  CAPABILITIES_UNAVAILABLE: {
    title: "Relayer unavailable",
    hint: "Tap to retry.",
    retryable: true,
  },
  WEBHOOK_UNVERIFIED: { title: "Unverified update ignored", retryable: false },
  CAVEATS_INVALID: { title: "Session permissions invalid", retryable: false },
  SESSION_NOT_FOUND: { title: "No active session", hint: "Join the room first.", retryable: false },
  ROOM_CLOSED: { title: "This room is closed", retryable: false },
  PAYMENT_REQUIRED: { title: "Payment required", retryable: false },
  SETTLEMENT_FAILED: { title: "Payment couldn't be confirmed", retryable: true },
  NONCE_REUSED: { title: "Duplicate request blocked", retryable: false },
  REVEAL_DENIED: { title: "You can't reveal that yet", retryable: false },
  SEAL_FAILED: { title: "Couldn't seal secret", retryable: true },
  RNG_PENDING: { title: "Waiting for randomness…", retryable: true },
  ORDER_NOT_SEALED: { title: "Deck isn't ready", retryable: true },
  INVALID_CONFIG: { title: "Misconfigured client", retryable: false },
  NOT_CONNECTED: { title: "Not connected", hint: "Tap to retry.", retryable: true },
  INTERNAL: { title: "Something went wrong", hint: "Tap to retry.", retryable: true },
};

/** Human-readable title for a NexusError. */
export function toMessage(e: NexusError): string {
  return COPY[e.code]?.title ?? COPY.INTERNAL.title;
}

/** Hint + retryability metadata for a NexusError. */
export function errorMeta(e: NexusError): { hint?: string; retryable: boolean } {
  const c = COPY[e.code] ?? COPY.INTERNAL;
  return { hint: c.hint, retryable: e.retryable ?? c.retryable };
}
