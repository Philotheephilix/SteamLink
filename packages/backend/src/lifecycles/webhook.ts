import { createHmac, timingSafeEqual } from "node:crypto";
import type { RelayerCapabilities } from "@nexus/relayer";
import type { StatusEvent } from "@nexus/relayer";
import type { FacilitatorAdapter } from "@nexus/server";
import { type Hex, NexusError } from "@nexus/types";

/** A 1Shot-style webhook payload (backend spec §4.5). */
export interface WebhookPayload {
  bundleId: string;
  status: "pending" | "mined" | "failed";
  txHash?: Hex;
  blockNumber?: number;
  revert?: string;
}

/**
 * Maps `bundleId → roomId/move/charge`, attached by submit-time registration.
 * For CHARGE bundles we also persist the redemption identity (nonce, payer,
 * delegationContext) so a "mined" webhook can be confirmed on-chain via
 * `facilitator.verify(...)` BEFORE the charge is treated as settled (C1).
 */
export interface CorrelationRecord {
  bundleId: string;
  roomId?: string;
  kind: "move" | "charge" | "settle" | "refund";
  player?: string;
  /** Charge-only: the 402 nonce minted at challenge time. */
  nonce?: Hex;
  /** Charge-only: the encoded delegation/permission context redeemed. */
  delegationContext?: Hex;
  /** Charge-only: the payer (delegation delegator) the settlement must come from. */
  payer?: Hex;
  /** Charge-only: the txHash known at submit time, if any. */
  txHash?: Hex;
}

/**
 * The webhook ledger (backend spec §6/§7): `bundleId → call` mapping + dedupe.
 * In-memory default; a Redis ledger implements the same surface (keys
 * `webhook:<bundleId>` for the correlation, `webhook:seen:<bundleId>` for dedupe).
 */
export interface WebhookLedger {
  claim(rec: CorrelationRecord): Promise<void>;
  correlation(bundleId: string): Promise<CorrelationRecord | null>;
  /** Returns true the FIRST time a bundleId is seen; false on re-delivery. */
  markSeen(bundleId: string): Promise<boolean>;
}

export class MemoryWebhookLedger implements WebhookLedger {
  private readonly correlations = new Map<string, CorrelationRecord>();
  private readonly seen = new Set<string>();

  async claim(rec: CorrelationRecord): Promise<void> {
    this.correlations.set(rec.bundleId, rec);
  }
  async correlation(bundleId: string): Promise<CorrelationRecord | null> {
    return this.correlations.get(bundleId) ?? null;
  }
  async markSeen(bundleId: string): Promise<boolean> {
    if (this.seen.has(bundleId)) return false;
    this.seen.add(bundleId);
    return true;
  }
}

/**
 * Verify webhook origin/signature over the RAW request body. `rawBody` is the
 * exact bytes the sender signed; it is `undefined` only on legacy in-process
 * calls, in which case a fail-closed verifier rejects. Returns true iff the
 * delivery is authentic.
 */
export type WebhookVerifier = (
  payload: WebhookPayload,
  headers: Record<string, string>,
  rawBody?: string,
) => boolean;

/** Header carrying the webhook HMAC signature. */
export const WEBHOOK_SIG_HEADER = "x-nexus-webhook-signature";

/**
 * Build a real HMAC-SHA256 webhook verifier (C2). The signature is computed over
 * the RAW request body keyed by the shared secret and compared in constant time.
 * When `secret` is absent the verifier FAILS CLOSED (rejects every delivery) —
 * the money path never trusts unsigned input.
 */
export function hmacWebhookVerifier(secret: string | undefined): WebhookVerifier {
  return (_payload, headers, rawBody) => {
    if (!secret) return false; // fail closed — no secret, no trust
    if (rawBody === undefined) return false;
    const sig = headers[WEBHOOK_SIG_HEADER] ?? headers[WEBHOOK_SIG_HEADER.toUpperCase()];
    if (!sig) return false;
    const expected = signWebhookBody(secret, rawBody);
    return constantTimeEqualHex(sig, expected);
  };
}

/** Compute the canonical webhook signature: `0x` + HMAC-SHA256(secret, rawBody). */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `0x${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const an = a.startsWith("0x") ? a.slice(2) : a;
  const bn = b.startsWith("0x") ? b.slice(2) : b;
  if (an.length !== bn.length || an.length === 0) return false;
  let ab: Buffer;
  let bb: Buffer;
  try {
    ab = Buffer.from(an, "hex");
    bb = Buffer.from(bn, "hex");
  } catch {
    return false;
  }
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export interface IngestResult {
  ok: boolean;
  deduped: boolean;
  correlation: CorrelationRecord | null;
}

/** Optional on-chain settlement dependencies for charge confirmation (C1). */
export interface WebhookSettlementDeps {
  /** The facilitator whose `verify()` confirms a charge settled on Base. */
  facilitator: FacilitatorAdapter;
  /** Relayer capabilities (or resolver) — reserved for token/finality context. */
  capabilities?: RelayerCapabilities | (() => Promise<RelayerCapabilities>);
}

/**
 * The webhook ingestion handler. Verifies origin (REQUIRED — C2), dedupes by
 * bundleId, maps the bundle to its pending call, and emits an internal
 * `StatusEvent` that drives move/charge resolution and indexer reconciliation.
 * Idempotent (backend spec §7).
 *
 * C1: for a CHARGE correlation, a "mined" webhook is NOT trusted on its face.
 * Before the charge is resolved as settled the handler calls
 * `facilitator.verify({ nonce, payer, txHash, delegationContext })`. Only a
 * confirmed on-chain settlement lets the "mined" event through; an unconfirmable
 * charge is downgraded to a "failed" event so the awaiting promise rejects rather
 * than reporting a fabricated success.
 */
export class WebhookHandler {
  private readonly listeners = new Set<(e: StatusEvent) => void>();
  private readonly verify: WebhookVerifier;
  private readonly settlement?: WebhookSettlementDeps;

  constructor(
    private readonly ledger: WebhookLedger,
    verify: WebhookVerifier,
    settlement?: WebhookSettlementDeps,
  ) {
    // C2: a verifier is MANDATORY. No silent `() => true` default.
    if (typeof verify !== "function") {
      throw new NexusError(
        "INVALID_CONFIG",
        "WebhookHandler requires an explicit verifier — refusing to fail open",
      );
    }
    this.verify = verify;
    this.settlement = settlement;
  }

  onStatus(cb: (e: StatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async ingest(
    payload: WebhookPayload,
    headers: Record<string, string> = {},
    rawBody?: string,
  ): Promise<IngestResult> {
    if (!this.verify(payload, headers, rawBody)) {
      throw new NexusError("WEBHOOK_UNVERIFIED", "webhook signature/origin check failed");
    }
    const first = await this.ledger.markSeen(payload.bundleId);
    const correlation = await this.ledger.correlation(payload.bundleId);
    if (!first) {
      // Re-delivery: no double-resolve, but report the known correlation.
      return { ok: true, deduped: true, correlation };
    }

    let event: StatusEvent = {
      bundleId: payload.bundleId,
      status: payload.status,
      ...(payload.txHash ? { txHash: payload.txHash } : {}),
      ...(payload.blockNumber !== undefined ? { blockNumber: BigInt(payload.blockNumber) } : {}),
      ...(payload.revert ? { revert: payload.revert } : {}),
    };

    // C1: a mined CHARGE must be confirmed on-chain before we treat it as settled.
    if (
      payload.status === "mined" &&
      correlation?.kind === "charge" &&
      this.settlement?.facilitator
    ) {
      const ok = await this.confirmChargeSettlement(payload, correlation);
      if (!ok.settled) {
        // Downgrade to failed so the awaiting promise rejects (no fabricated win).
        event = {
          bundleId: payload.bundleId,
          status: "failed",
          ...(payload.txHash ? { txHash: payload.txHash } : {}),
          revert: ok.reason ?? "charge settlement could not be confirmed on-chain",
        };
      }
    }

    for (const l of this.listeners) l(event);
    return { ok: true, deduped: false, correlation };
  }

  /**
   * Confirm a charge actually settled on-chain via `facilitator.verify`. Returns
   * `{ settled: true }` only on a confirmed settlement; otherwise reports the
   * reason. Never throws — confirmation failure becomes a `failed` StatusEvent.
   */
  private async confirmChargeSettlement(
    payload: WebhookPayload,
    correlation: CorrelationRecord,
  ): Promise<{ settled: boolean; reason?: string }> {
    const facilitator = this.settlement?.facilitator;
    if (!facilitator) return { settled: false, reason: "no facilitator configured" };
    const txHash = payload.txHash ?? correlation.txHash;
    if (!correlation.nonce || !correlation.payer || !txHash) {
      return {
        settled: false,
        reason: "charge correlation missing nonce/payer/txHash — cannot confirm settlement",
      };
    }
    try {
      const settlement = await facilitator.verify({
        nonce: correlation.nonce,
        payer: correlation.payer,
        delegationContext: correlation.delegationContext ?? ("0x" as Hex),
        txHash,
      });
      if (
        settlement.status === "settled" &&
        settlement.from.toLowerCase() === correlation.payer.toLowerCase()
      ) {
        return { settled: true };
      }
      return { settled: false, reason: "settlement payer mismatch or not settled" };
    } catch (err) {
      return { settled: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
