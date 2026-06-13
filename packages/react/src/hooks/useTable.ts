import type { NexusError } from "@nexus/types";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { queryKey } from "../optimistic/store.js";
import type { Row, Where } from "../transport.js";
import { useNexus } from "./useNexus.js";

export interface UseTableResult<T extends Row = Row> {
  data: T[];
  status: "loading" | "live" | "degraded";
  loading: boolean;
  error: NexusError | null;
  /** True while a pending optimistic overlay affects this query. */
  isOptimistic: boolean;
}

/**
 * Live, auto-synced table read. Subscribes via the manager (deduped/ref-counted),
 * seeds from the store, applies optimistic overlays, and updates on transport
 * push. `where` is keyed by stable value, so inline object literals don't thrash
 * the subscription.
 */
export function useTable<T extends Row = Row>(table: string, where: Where): UseTableResult<T> {
  const { manager } = useNexus();

  // Stable key from value, not reference: re-renders with an equal `where`
  // literal produce the same key and reuse the same subscription.
  const key = queryKey(table, where);

  // Hold a `where` snapshot that only changes identity when the key changes, so
  // inline object literals don't thrash the subscription effect.
  const whereRef = useRef<{ key: string; where: Where }>({ key, where });
  if (whereRef.current.key !== key) {
    whereRef.current = { key, where };
  }
  const stableWhere = whereRef.current.where;

  const subscribe = useCallback(
    (cb: () => void) => {
      const offStore = manager.store.subscribe(key, cb);
      const offSub = manager.subscribe(table, stableWhere);
      const offStatus = manager.onStatusChange(cb);
      return () => {
        offStore();
        offSub();
        offStatus();
      };
    },
    [manager, key, table, stableWhere],
  );

  const data = useSyncExternalStore(
    subscribe,
    () => manager.store.getSnapshot(key) as T[],
    () => manager.store.getSnapshot(key) as T[],
  );

  const loaded = manager.isLoaded(table, stableWhere);
  const mgrStatus = manager.status();
  const status: UseTableResult["status"] = !loaded
    ? "loading"
    : mgrStatus === "degraded"
      ? "degraded"
      : "live";

  return {
    data,
    status,
    loading: status === "loading",
    error: null,
    isOptimistic: manager.store.hasPendingOverlay(key),
  };
}
