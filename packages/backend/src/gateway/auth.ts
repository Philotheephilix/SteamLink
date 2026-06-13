import { type Address, type Hex, NexusError, asAddress } from "@nexus/types";
import { hashMessage, keccak256, recoverMessageAddress, toHex, verifyMessage } from "viem";

/**
 * Caller auth (backend spec §8, phase-05 §4.2). Session-scoped routes verify the
 * player's smart-account signature over a CANONICAL request payload
 * (method + path + bodyHash + nonce + timestamp). No API keys reach the browser.
 *
 * Two verification modes:
 *  - EIP-191 personal_sign over the canonical string (default for EOAs / SCA).
 *  - EIP-1271 (smart-account) verification via `verifyMessage` with a public
 *    client (injected); used when the account is a deployed contract wallet.
 *
 * H3 hardening:
 *  - Replay protection is backed by an INJECTABLE TTL nonce store (the gateway
 *    wires the SessionStore-backed store) instead of an unbounded module-global
 *    Set that leaks memory and is not shared across instances.
 *  - ecrecover AND the EIP-1271 path use ONE canonical EIP-191 digest
 *    (`hashMessage`), so a smart-account `isValidSignature` sees the same hash a
 *    plain ecrecover would — no digest mismatch that silently passes/fails.
 *  - Timestamps in the FUTURE beyond a small clock skew are rejected.
 */
export interface SignedRequest {
  method: string;
  path: string;
  body: unknown;
  /** Single-use nonce (replay protection). */
  nonce: string;
  /** Epoch ms; rejected if too old. */
  timestamp: number;
  /** The claimed signer (smart-account address). */
  caller: Address;
  /** The signature over the canonical payload. */
  signature: Hex;
}

/**
 * A minimal replay-nonce store. The default is in-memory with TTL eviction; the
 * gateway injects a SessionStore-backed implementation so replay protection is
 * shared across instances and bounded. `checkAndConsume` MUST be atomic: it
 * returns `false` (and records the nonce) on first sight, `true` if already seen.
 */
export interface NonceReplayStore {
  /** Returns true if the nonce was already used; otherwise records it and returns false. */
  checkAndConsume(nonce: string, now: number): boolean;
}

/** Default TTL: a nonce is remembered for 2× the max request age, then evicted. */
export const DEFAULT_NONCE_REPLAY_TTL_MS = 120_000;

/**
 * A bounded, TTL-evicting in-memory replay store. Entries older than `ttlMs` are
 * swept on access, so memory stays bounded by the request rate over the TTL
 * window — unlike the previous unbounded module-global Set.
 */
export class TtlNonceReplayStore implements NonceReplayStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = DEFAULT_NONCE_REPLAY_TTL_MS) {}

  checkAndConsume(nonce: string, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) return true;
    this.seen.set(nonce, now + this.ttlMs);
    return false;
  }

  private sweep(now: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
  }
}

export interface AuthConfig {
  /** Max age of a request signature in ms. Default 60s. */
  maxAgeMs?: number;
  /** Allowed clock skew for FUTURE-dated timestamps in ms. Default 5s. */
  futureSkewMs?: number;
  /**
   * Optional EIP-1271 verifier (for deployed smart accounts). When provided and
   * the EIP-191 ecrecover does not match, this is consulted. Injected with a viem
   * public client in prod; omitted in tests that use EOA personal_sign. Receives
   * the CANONICAL EIP-191 digest (`hashMessage`) — the same hash ecrecover used.
   */
  verify1271?: (caller: Address, hash: Hex, signature: Hex) => Promise<boolean>;
  /**
   * Replay-nonce store. Injected by the gateway (SessionStore/TTL backed). When
   * omitted, a process-local bounded TTL store is used (dev/test only).
   */
  nonceStore?: NonceReplayStore;
}

/** Build the canonical message a caller signs for a session-scoped request. */
export function canonicalMessage(req: Omit<SignedRequest, "signature" | "caller">): string {
  const bodyHash = keccak256(toHex(JSON.stringify(req.body ?? null)));
  return [req.method.toUpperCase(), req.path, bodyHash, req.nonce, String(req.timestamp)].join(
    "\n",
  );
}

/** A single process-local store used only when the caller injects none. */
const defaultReplayStore = new TtlNonceReplayStore();

/**
 * Verify a signed session-scoped request. Throws `NexusError("NOT_CONNECTED")` on
 * a signature/timestamp failure and `NexusError("NONCE_REUSED")` on replay.
 * Returns the verified caller (the RECOVERED signer — callers must use this, not
 * any body-supplied address).
 */
export async function verifyRequest(req: SignedRequest, cfg: AuthConfig = {}): Promise<Address> {
  const maxAge = cfg.maxAgeMs ?? 60_000;
  const futureSkew = cfg.futureSkewMs ?? 5_000;
  const now = Date.now();
  if (!Number.isFinite(req.timestamp)) {
    throw new NexusError("NOT_CONNECTED", "request timestamp invalid");
  }
  if (now - req.timestamp > maxAge) {
    throw new NexusError("NOT_CONNECTED", "request timestamp expired");
  }
  if (req.timestamp - now > futureSkew) {
    throw new NexusError("NOT_CONNECTED", "request timestamp is in the future beyond allowed skew");
  }

  const message = canonicalMessage(req);
  const caller = asAddress(req.caller);
  // ONE canonical EIP-191 digest used for every verification path (H3).
  const digest = hashMessage(message);

  // EIP-191 ecrecover fast path.
  let ok = false;
  try {
    const recovered = await recoverMessageAddress({ message, signature: req.signature });
    ok = recovered.toLowerCase() === caller.toLowerCase();
  } catch {
    ok = false;
  }
  if (!ok) {
    // viem's verifyMessage also handles ERC-6492 / ERC-1271 when given a client;
    // here use the structural verify as a second attempt over the SAME message.
    try {
      ok = await verifyMessage({ address: caller, message, signature: req.signature });
    } catch {
      ok = false;
    }
  }
  if (!ok && cfg.verify1271) {
    // Pass the canonical EIP-191 digest so the contract's isValidSignature sees
    // exactly the hash ecrecover validated above (no digest mismatch).
    ok = await cfg.verify1271(caller, digest, req.signature);
  }
  if (!ok) throw new NexusError("NOT_CONNECTED", "smart-account signature verification failed");

  // Consume the nonce ONLY after the signature is proven valid, so a forged
  // request can't burn a victim's nonce.
  const store = cfg.nonceStore ?? defaultReplayStore;
  if (store.checkAndConsume(req.nonce, now)) {
    throw new NexusError("NONCE_REUSED", "request nonce replayed");
  }

  return caller;
}
