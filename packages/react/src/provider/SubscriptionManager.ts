import { type PendingResolver, type StatusEvent, reconcile } from "../optimistic/reconcile.js";
import { type Overlay, OverlayStore, queryKey } from "../optimistic/store.js";
import type { Transport, Where } from "../transport.js";

export type ManagerStatus = "live" | "degraded" | "closed";

/**
 * Shared per-provider session + budget-ledger state. Every useSession/useCharge
 * instance reads this one external store (via useSyncExternalStore) so they stay
 * consistent. Stands in for the Phase 03 client session ledger until the live
 * backend lands.
 */
export interface SessionState {
  session: unknown | null;
  /** Confirmed/optimistic spend, human USDC units. */
  spent: string;
}

export class SessionStore {
  private state: SessionState = { session: null, spent: "0" };
  private listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  getSnapshot(): SessionState {
    return this.state;
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }
  setSession(session: unknown | null): void {
    this.state = { session, spent: "0" };
    this.emit();
  }
  setSpent(spent: string): void {
    this.state = { ...this.state, spent };
    this.emit();
  }
}

interface KeyState {
  table: string;
  where: Where;
  refs: number;
  unsubscribe: (() => void) | null;
  /** Whether an initial query has populated base yet. */
  loaded: boolean;
  /** Pending teardown timer (grace delay for StrictMode remounts). */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/** Grace delay before tearing down a zero-ref subscription (survives StrictMode). */
const GRACE_MS = 50;

/**
 * One per provider. Multiplexes every hook's table subscription over the single
 * transport, deduping and ref-counting by query key, caching the last value, and
 * feeding rows into the shared OverlayStore. Holds the pending-bundle resolver
 * map so action hooks can await reconciliation.
 */
export class SubscriptionManager {
  readonly store = new OverlayStore();
  readonly session = new SessionStore();
  readonly pending = new Map<string, PendingResolver>();

  private keys = new Map<string, KeyState>();
  private _status: ManagerStatus = "live";
  private statusListeners = new Set<(s: ManagerStatus) => void>();

  constructor(private readonly transport: Transport) {}

  status(): ManagerStatus {
    return this._status;
  }

  onStatusChange(cb: (s: ManagerStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private setStatus(s: ManagerStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  /** Whether base rows for this key have loaded (used to derive loading state). */
  isLoaded(table: string, where: Where): boolean {
    return this.keys.get(queryKey(table, where))?.loaded ?? false;
  }

  /**
   * Subscribe a hook instance to a (table, where) key. Returns an unsubscribe
   * that decrements the ref count; the underlying transport sub tears down only
   * when the count hits zero (after a short grace delay).
   */
  subscribe(table: string, where: Where): () => void {
    const key = queryKey(table, where);
    let ks = this.keys.get(key);
    if (!ks) {
      ks = { table, where, refs: 0, unsubscribe: null, loaded: false, graceTimer: null };
      this.keys.set(key, ks);
    }
    if (ks.graceTimer) {
      clearTimeout(ks.graceTimer);
      ks.graceTimer = null;
    }
    ks.refs += 1;

    if (!ks.unsubscribe) {
      ks.unsubscribe = this.transport.subscribe(table, where, (rows) => {
        ks!.loaded = true;
        this.store.setBase(key, rows);
      });
      // Seed base via a one-shot query so a fresh consumer fills immediately.
      void this.transport
        .query(table, where)
        .then((rows) => {
          if (!ks!.loaded) {
            ks!.loaded = true;
            this.store.setBase(key, rows);
          }
        })
        .catch(() => {
          /* subscribe push will still fill base; surface via status if needed */
        });
    }

    return () => {
      ks!.refs -= 1;
      if (ks!.refs <= 0) {
        ks!.graceTimer = setTimeout(() => {
          if (ks!.refs <= 0) {
            ks!.unsubscribe?.();
            this.keys.delete(key);
          }
        }, GRACE_MS);
      }
    };
  }

  /** Register a pending bundle and return the bundleId for reconciliation. */
  trackPending(bundleId: string, resolver: PendingResolver): void {
    this.pending.set(bundleId, resolver);
  }

  /** Feed a relayer status event through the reconciler. */
  applyStatus(evt: StatusEvent): void {
    reconcile(this.store, this.pending, evt);
  }

  /** Register an optimistic overlay for a query. */
  addOverlay(table: string, where: Where, overlay: Overlay): void {
    this.store.addOverlay(queryKey(table, where), overlay);
  }

  markDegraded(): void {
    this.setStatus("degraded");
  }

  markLive(): void {
    this.setStatus("live");
  }

  dispose(): void {
    for (const ks of this.keys.values()) {
      if (ks.graceTimer) clearTimeout(ks.graceTimer);
      ks.unsubscribe?.();
    }
    this.keys.clear();
    this.pending.clear();
    this.statusListeners.clear();
    this.setStatus("closed");
  }
}
