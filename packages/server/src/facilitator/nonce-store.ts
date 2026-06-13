import { type Hex, NexusError } from "@nexus/types";
import { bytesToHex } from "viem";

/**
 * The record kept per issued 402 nonce. The nonce is single-use: `consume()`
 * atomically flips `used` and a second consume is rejected as a replay.
 */
export interface NonceRecord {
  nonce: Hex;
  payer: Hex;
  /** Amount (smallest unit) the challenge committed to. */
  price: string;
  recipient: Hex;
  expiresAt: number;
  /**
   * Epoch ms the nonce was issued. Binds settlement to challenge time (H2): a tx
   * mined before this instant cannot satisfy the nonce. Defaulted by `issue()`.
   */
  issuedAt: number;
  used: boolean;
}

/**
 * Replay-protection store for single-use 402 nonces (backend spec §8). The
 * default is in-memory (dev); a Redis-backed implementation swaps in for prod
 * by satisfying this same interface (atomic `SET NX` / Lua CAS for `consume`).
 */
export interface NonceStore {
  /**
   * Mint and persist a fresh nonce for a challenge. `issuedAt` is optional and
   * defaults to "now"; the store stamps it so `verify()` can bind a settlement
   * to the challenge time (H2).
   */
  issue(
    input: Omit<NonceRecord, "nonce" | "used" | "issuedAt"> & { issuedAt?: number },
  ): NonceRecord;
  /** Look up an issued nonce, or undefined if never issued. */
  get(nonce: Hex): NonceRecord | undefined;
  /**
   * Atomically single-use a nonce. Returns the record on success. Throws
   * `REPLAY` if already used, `CHALLENGE_EXPIRED` if past `expiresAt`, and
   * `NONCE_REUSED`/`SETTLEMENT_FAILED` if never issued.
   */
  consume(nonce: Hex, now?: number): NonceRecord;
  /**
   * Roll a consumed nonce back to unused — ONLY safe for RETRYABLE failures
   * (transient receipt-read errors). It is a no-op if the nonce is unknown or
   * already unused. Never call this on a definitive SETTLEMENT_FAILED, or the
   * nonce becomes a grinding oracle (H1).
   */
  rollback(nonce: Hex): void;
}

/** Default challenge TTL: 5 minutes. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

/** Generate a cryptographically random 32-byte nonce. */
export function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export class InMemoryNonceStore implements NonceStore {
  private readonly records = new Map<Hex, NonceRecord>();

  issue(
    input: Omit<NonceRecord, "nonce" | "used" | "issuedAt"> & { issuedAt?: number },
  ): NonceRecord {
    const record: NonceRecord = {
      ...input,
      issuedAt: input.issuedAt ?? Date.now(),
      nonce: randomNonce(),
      used: false,
    };
    this.records.set(record.nonce, record);
    return record;
  }

  get(nonce: Hex): NonceRecord | undefined {
    return this.records.get(nonce);
  }

  rollback(nonce: Hex): void {
    const record = this.records.get(nonce);
    if (record) record.used = false;
  }

  consume(nonce: Hex, now: number = Date.now()): NonceRecord {
    const record = this.records.get(nonce);
    if (!record) {
      throw new NexusError("NONCE_REUSED", `unknown 402 nonce: ${nonce}`);
    }
    if (record.used) {
      throw new NexusError("NONCE_REUSED", `402 nonce already redeemed: ${nonce}`, {
        context: { reason: "REPLAY" },
      });
    }
    if (now > record.expiresAt) {
      throw new NexusError("PAYMENT_REQUIRED", `402 challenge expired: ${nonce}`, {
        context: { reason: "CHALLENGE_EXPIRED" },
      });
    }
    // Atomic in JS's single-threaded model; Redis impl uses SET NX / Lua CAS.
    record.used = true;
    return record;
  }
}
