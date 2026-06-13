import type { Row } from "../transport.js";

/** Stable serialization of a (table, where) pair into a query key. */
export function queryKey(table: string, where: Record<string, unknown>): string {
  const keys = Object.keys(where).sort();
  const norm: Record<string, unknown> = {};
  for (const k of keys) {
    const v = where[k];
    norm[k] = typeof v === "bigint" ? `${v.toString()}n` : v;
  }
  return `${table}::${JSON.stringify(norm)}`;
}

/** A pending optimistic mutation over a query's base rows. */
export interface Overlay {
  bundleId: string;
  /** Pure transform applied over base rows to predict the post-move state. */
  mutate: (rows: Row[]) => Row[];
  status: "pending" | "confirmed";
}

interface Entry {
  base: Row[];
  overlays: Overlay[];
  /** Memoized result of applyOverlays(base, overlays) for referential stability. */
  snapshot: Row[];
}

/**
 * Per-provider overlay store. Holds indexer-truth `base` rows per query key plus
 * any pending optimistic overlays, and exposes a `useSyncExternalStore`-friendly
 * subscribe/getSnapshot surface. The rendered value is `base` with overlays
 * applied; overlays are committed (folded into base) or rolled back by the
 * reconciler.
 */
export class OverlayStore {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  /** bundleId -> set of query keys it touched, for reconciliation fan-out. */
  private byBundle = new Map<string, Set<string>>();

  private ensure(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { base: [], overlays: [], snapshot: [] };
      this.entries.set(key, e);
    }
    return e;
  }

  private recompute(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.snapshot = e.overlays.reduce((rows, o) => o.mutate(rows), e.base);
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  /** Current rendered rows (base + overlays). Stable reference between changes. */
  getSnapshot(key: string): Row[] {
    return this.entries.get(key)?.snapshot ?? EMPTY;
  }

  hasPendingOverlay(key: string): boolean {
    return (this.entries.get(key)?.overlays.length ?? 0) > 0;
  }

  private emit(key: string): void {
    const set = this.listeners.get(key);
    if (set) for (const cb of set) cb();
  }

  /** Replace base rows for a query (indexer push / initial fetch). */
  setBase(key: string, rows: Row[]): void {
    const e = this.ensure(key);
    e.base = rows;
    this.recompute(key);
    this.emit(key);
  }

  /** Register an optimistic overlay against one query. */
  addOverlay(key: string, overlay: Overlay): void {
    const e = this.ensure(key);
    e.overlays = [...e.overlays, overlay];
    this.recompute(key);
    let keys = this.byBundle.get(overlay.bundleId);
    if (!keys) {
      keys = new Set();
      this.byBundle.set(overlay.bundleId, keys);
    }
    keys.add(key);
    this.emit(key);
  }

  /** Drop every overlay for a bundle (rollback on failure / fold-in on commit). */
  removeOverlays(bundleId: string): void {
    const keys = this.byBundle.get(bundleId);
    if (!keys) return;
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      e.overlays = e.overlays.filter((o) => o.bundleId !== bundleId);
      this.recompute(key);
      this.emit(key);
    }
    this.byBundle.delete(bundleId);
  }

  /** True if any overlay for this bundle is still registered. */
  hasBundle(bundleId: string): boolean {
    return this.byBundle.has(bundleId);
  }
}

const EMPTY: Row[] = [];
