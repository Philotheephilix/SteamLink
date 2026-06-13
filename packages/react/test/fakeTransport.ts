import type { Address } from "@nexus/types";
import type { Row, Transport, TurnSnapshot, Where } from "../src/index.js";
import { queryKey } from "../src/index.js";

/** Does a row satisfy a `where` filter (shallow equality, bigint-aware)? */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const rv = row[k];
    if (typeof v === "bigint" || typeof rv === "bigint") return String(rv) === String(v);
    return rv === v;
  });
}

/**
 * In-memory transport for tests. Holds seeded tables, lets a test push updates to
 * simulate indexer/WS events, and records submitted redemptions so the test can
 * drive reconciliation. This is dependency injection — the SDK's delegation /
 * optimistic logic still runs for real against it.
 */
export class FakeTransport implements Transport {
  private tables = new Map<string, Row[]>();
  private subs = new Map<string, Set<(rows: Row[]) => void>>();
  private turns = new Map<string, TurnSnapshot>();
  readonly submitted: Array<{ calldata: string; bundleId: string }> = [];
  /** Spy: how many live subscriptions were opened per key. */
  readonly subscribeCalls: string[] = [];

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  setTurn(roomId: bigint, snap: TurnSnapshot): void {
    this.turns.set(roomId.toString(), snap);
  }

  /** Replace a table's rows and notify all matching live subscribers. */
  push(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
    for (const [key, set] of this.subs) {
      if (!key.startsWith(`${table}::`)) continue;
      const where = JSON.parse(key.slice(key.indexOf("::") + 2)) as Where;
      const filtered = rows.filter((r) => matches(r, where));
      for (const cb of set) cb(filtered);
    }
  }

  async query(table: string, where: Where): Promise<Row[]> {
    return (this.tables.get(table) ?? []).filter((r) => matches(r, where));
  }

  subscribe(table: string, where: Where, cb: (rows: Row[]) => void): () => void {
    const key = queryKey(table, where);
    this.subscribeCalls.push(key);
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(cb);
    // Immediate emit of current matching rows.
    cb((this.tables.get(table) ?? []).filter((r) => matches(r, where)));
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.subs.delete(key);
    };
  }

  async getTurn(roomId: bigint): Promise<TurnSnapshot> {
    return this.turns.get(roomId.toString()) ?? { current: null, deadline: null, direction: null };
  }

  async submit(req: { calldata: string; bundleId: string }): Promise<{ bundleId: string }> {
    this.submitted.push({ calldata: req.calldata, bundleId: req.bundleId });
    return { bundleId: req.bundleId };
  }
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
