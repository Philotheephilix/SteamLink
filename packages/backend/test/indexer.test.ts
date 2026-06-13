import type { Hex } from "@nexus/types";
import { encodeAbiParameters, encodeEventTopics, pad, toHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryIndexer,
  type RawLog,
  STORE_SET_RECORD,
  allIndexerSchemas,
  buildTableRegistry,
  decodeStoreLog,
  toIndexerSchema,
} from "../src/index.js";
import { PLAYER, TURN_ORDER_TABLE_ID, uno } from "./fixtures.js";

/**
 * Build a real Store_SetRecord log for the TurnOrder table:
 *   key   = [roomId]  (uint256, key field)
 *   value = [current(address), direction(uint8)]
 */
function turnOrderLog(
  roomId: bigint,
  current: Hex,
  direction: number,
  block: number,
  logIndex: number,
): RawLog {
  const topics = encodeEventTopics({
    abi: [STORE_SET_RECORD],
    eventName: "Store_SetRecord",
    args: { tableId: TURN_ORDER_TABLE_ID },
  });
  const keyTuple = [pad(toHex(roomId), { size: 32 })];
  const staticData = encodeAbiParameters(
    [
      { name: "current", type: "address" },
      { name: "direction", type: "uint8" },
    ],
    [current, direction],
  );
  const data = encodeAbiParameters(
    [
      { name: "keyTuple", type: "bytes32[]" },
      { name: "staticData", type: "bytes" },
      { name: "dynamicData", type: "bytes" },
    ],
    [keyTuple as Hex[], staticData, "0x"],
  );
  return { topics: topics as Hex[], data, blockNumber: block, logIndex };
}

async function startIndexer() {
  const ix = new InMemoryIndexer();
  await ix.start({
    chain: "base",
    world: `0x${"00".repeat(20)}`,
    games: allIndexerSchemas(new Map([["uno", uno]])),
  });
  return ix;
}

describe("InMemoryIndexer", () => {
  it("derives a schema with the first field as the key", () => {
    const schema = toIndexerSchema(uno);
    const turn = schema.tables.find((t) => t.table === "TurnOrder");
    expect(turn?.fields[0]).toMatchObject({ name: "roomId", key: true });
    expect(turn?.fields[1]).toMatchObject({ name: "current", key: false });
    expect(turn?.tableId.toLowerCase()).toBe(TURN_ORDER_TABLE_ID.toLowerCase());
  });

  it("ingests a decoded Store_SetRecord and query() returns the row", async () => {
    const ix = await startIndexer();
    const change = ix.ingestLog(turnOrderLog(7n, PLAYER, 1, 100, 2));
    expect(change?.type).toBe("set");

    const rows = await ix.query("TurnOrder", { roomId: 7n });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      roomId: 7n,
      current: PLAYER.toLowerCase(),
      direction: 1,
      __block: 100,
      __logIndex: 2,
    });
  });

  it("subscribe() emits the row on ingest for matching where", async () => {
    const ix = await startIndexer();
    const cb = vi.fn();
    ix.subscribe("TurnOrder", { roomId: 7n }, cb);
    ix.ingestLog(turnOrderLog(7n, PLAYER, 1, 101, 0));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({
      type: "set",
      table: "TurnOrder",
      key: { roomId: 7n },
    });

    // a non-matching room does not emit to this subscriber
    ix.ingestLog(turnOrderLog(9n, PLAYER, 1, 102, 0));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ignores logs for unknown tables", async () => {
    const ix = await startIndexer();
    const log = turnOrderLog(7n, PLAYER, 1, 100, 2);
    log.topics = [log.topics[0] as Hex, `0x${"11".repeat(32)}` as Hex];
    expect(ix.ingestLog(log)).toBeNull();
  });
});

describe("decodeStoreLog strictness (H5)", () => {
  const registry = buildTableRegistry(allIndexerSchemas(new Map([["uno", uno]])));

  /** Build a Store_SetRecord log with explicit key/static/dynamic blobs. */
  function rawSet(tableId: Hex, keyTuple: Hex[], staticData: Hex, dynamicData: Hex = "0x"): RawLog {
    const topics = encodeEventTopics({
      abi: [STORE_SET_RECORD],
      eventName: "Store_SetRecord",
      args: { tableId },
    });
    const data = encodeAbiParameters(
      [
        { name: "keyTuple", type: "bytes32[]" },
        { name: "staticData", type: "bytes" },
        { name: "dynamicData", type: "bytes" },
      ],
      [keyTuple, staticData, dynamicData],
    );
    return { topics: topics as Hex[], data, blockNumber: 1, logIndex: 0 };
  }

  const goodStatic = encodeAbiParameters(
    [
      { name: "current", type: "address" },
      { name: "direction", type: "uint8" },
    ],
    [PLAYER, 1],
  ) as Hex;

  it("decodes a well-formed TurnOrder record", () => {
    const log = rawSet(TURN_ORDER_TABLE_ID, [pad(toHex(7n), { size: 32 })], goodStatic);
    const change = decodeStoreLog(log, registry);
    expect(change?.type).toBe("set");
  });

  it("rejects (null) a keyTuple whose length != the key field count", () => {
    // TurnOrder has ONE key field (roomId). Two key words is a forged encoding.
    const log = rawSet(
      TURN_ORDER_TABLE_ID,
      [pad(toHex(7n), { size: 32 }), pad(toHex(8n), { size: 32 })],
      goodStatic,
    );
    expect(decodeStoreLog(log, registry)).toBeNull();
  });

  it("rejects (null) an empty keyTuple instead of zero-filling the key", () => {
    const log = rawSet(TURN_ORDER_TABLE_ID, [], goodStatic);
    expect(decodeStoreLog(log, registry)).toBeNull();
  });

  it("rejects (null) staticData whose length doesn't match the schema", () => {
    // Two static fields → 64 bytes expected; supply only 32.
    const shortStatic = `0x${"00".repeat(32)}` as Hex;
    const log = rawSet(TURN_ORDER_TABLE_ID, [pad(toHex(7n), { size: 32 })], shortStatic);
    expect(decodeStoreLog(log, registry)).toBeNull();
  });
});
