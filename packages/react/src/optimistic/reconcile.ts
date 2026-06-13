import { NexusError, type NexusErrorCode } from "@nexus/types";
import type { OverlayStore } from "./store.js";

/** Terminal/transition status for a submitted bundle, fed by the relayer webhook. */
export interface StatusEvent {
  bundleId: string;
  status: "pending" | "mined" | "failed";
  /** On `failed`, the decoded enforcer/relayer reason. */
  code?: NexusErrorCode;
  /** On `failed`, a human-readable reason. */
  reason?: string;
  txHash?: string;
}

/** Per-bundle reconciliation hooks the action hooks register. */
export interface PendingResolver {
  resolve: (evt: StatusEvent) => void;
  reject: (err: NexusError) => void;
}

/**
 * Order-independent, idempotent reconciler. On `mined` it drops the bundle's
 * overlays (the matching indexer push refreshes base — net no flicker) and
 * resolves the pending promise. On `failed` it rolls the overlays back and
 * rejects with a typed NexusError. Duplicate events for a settled bundle are
 * ignored.
 */
export function reconcile(
  store: OverlayStore,
  pending: Map<string, PendingResolver>,
  evt: StatusEvent,
): void {
  if (evt.status === "pending") return;

  const resolver = pending.get(evt.bundleId);
  // Idempotent: if neither an overlay nor a resolver remains, this is a dup.
  if (!resolver && !store.hasBundle(evt.bundleId)) return;

  if (evt.status === "mined") {
    store.removeOverlays(evt.bundleId);
    resolver?.resolve(evt);
  } else {
    store.removeOverlays(evt.bundleId);
    const err = new NexusError(evt.code ?? "RELAYER_FAILED", evt.reason ?? "move failed on chain", {
      txHash: evt.txHash,
    });
    resolver?.reject(err);
  }
  pending.delete(evt.bundleId);
}
