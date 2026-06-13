import type { Address } from "@nexus/types";

/**
 * A live table row. Rows are plain records keyed by string; the concrete shape
 * is game-specific (generated `Tables` in Phase 03). The transport stays
 * schema-agnostic so it can be swapped for the real gateway/indexer later.
 */
export type Row = Record<string, unknown>;

/** A `where` filter — a partial match against a row's fields. */
export type Where = Record<string, unknown>;

/** Current turn snapshot for a room, as the indexer exposes it. */
export interface TurnSnapshot {
  /** Address whose turn it currently is, or null if unknown / room not started. */
  current: Address | null;
  /** Epoch ms of the on-chain turn deadline, if any. */
  deadline: number | null;
  /** Play direction (UNO-style), if the game tracks one. */
  direction: 1 | -1 | null;
}

/**
 * The transport adapter is the single seam between the React hooks and the live
 * backend. The hooks depend ONLY on this interface — never on a concrete WS or
 * HTTP client — so tests inject an in-memory fake and production wires the real
 * Phase 05/06 gateway + indexer. This is dependency injection, not mocking: the
 * SDK's own delegation/optimistic logic still runs for real.
 */
export interface Transport {
  /** One-shot read of all rows in `table` matching `where`. */
  query(table: string, where: Where): Promise<Row[]>;
  /**
   * Live subscription. `cb` is invoked with the full current row set for the
   * (table, where) key on every change. Returns an unsubscribe function.
   */
  subscribe(table: string, where: Where, cb: (rows: Row[]) => void): () => void;
  /** Current turn for a room. */
  getTurn(roomId: bigint): Promise<TurnSnapshot>;
  /**
   * Submit an already-built redemption (calldata produced by the core delegation
   * engine) to the relayer/gateway. Resolves with a correlation id (`bundleId`).
   * Optional: a transport that is read-only (e.g. SSR) may omit it.
   */
  submit?(redemption: SubmitRequest): Promise<{ bundleId: string }>;
}

/** A redemption ready to hand to the relayer. */
export interface SubmitRequest {
  /** Encoded `manager.redeemDelegations(...)` calldata from the core engine. */
  calldata: import("@nexus/types").Hex;
  /** Correlation id the caller assigned for optimistic reconciliation. */
  bundleId: string;
  /** Free-form metadata (system name, room id) for logging. */
  meta?: Record<string, unknown>;
}
