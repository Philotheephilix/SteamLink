import type { Hex } from "@nexus/types";
import { type AbiEvent, decodeAbiParameters, decodeEventLog } from "viem";
import type { IndexerGameSchema, IndexerTableSchema, RowChange } from "../ports/indexer.js";

/**
 * The World's canonical Store events (from `packages/contracts/src/world/World.sol`):
 *
 *   event Store_SetRecord(bytes32 indexed tableId, bytes32[] keyTuple, bytes staticData, bytes dynamicData);
 *   event Store_DeleteRecord(bytes32 indexed tableId, bytes32[] keyTuple);
 *
 * These two families drive every projection. `decode.ts` is PURE (no DB, no
 * network) so it is unit-testable against fixture logs.
 */
export const STORE_SET_RECORD: AbiEvent = {
  type: "event",
  name: "Store_SetRecord",
  inputs: [
    { name: "tableId", type: "bytes32", indexed: true },
    { name: "keyTuple", type: "bytes32[]", indexed: false },
    { name: "staticData", type: "bytes", indexed: false },
    { name: "dynamicData", type: "bytes", indexed: false },
  ],
};

export const STORE_DELETE_RECORD: AbiEvent = {
  type: "event",
  name: "Store_DeleteRecord",
  inputs: [
    { name: "tableId", type: "bytes32", indexed: true },
    { name: "keyTuple", type: "bytes32[]", indexed: false },
  ],
};

export const STORE_EVENTS_ABI = [STORE_SET_RECORD, STORE_DELETE_RECORD] as const;

/** A raw EVM log as observed from the chain (subset of viem's `Log`). */
export interface RawLog {
  topics: [Hex, ...Hex[]] | Hex[];
  data: Hex;
  blockNumber: bigint | number;
  logIndex: number;
}

/** tableId -> (game, table schema) resolver, built once from the mounted games. */
export function buildTableRegistry(
  games: IndexerGameSchema[],
): Map<Hex, { game: string; schema: IndexerTableSchema }> {
  const registry = new Map<Hex, { game: string; schema: IndexerTableSchema }>();
  for (const game of games) {
    for (const schema of game.tables) {
      registry.set(schema.tableId.toLowerCase() as Hex, { game: game.name, schema });
    }
  }
  return registry;
}

/**
 * Decode one World Store log into a `RowChange`, or `null` if the tableId is not
 * one of the mounted game tables. Key fields decode from `keyTuple` (each a
 * left-/right-padded bytes32); value fields decode from `staticData` as a tight
 * ABI tuple in declared order.
 */
export function decodeStoreLog(
  log: RawLog,
  registry: Map<Hex, { game: string; schema: IndexerTableSchema }>,
): RowChange | null {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: STORE_EVENTS_ABI,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    }) as never;
  } catch {
    return null;
  }

  const tableId = (decoded.args.tableId as Hex).toLowerCase() as Hex;
  const entry = registry.get(tableId);
  if (!entry) return null;

  const { schema } = entry;
  const keyTuple = (decoded.args.keyTuple as Hex[]) ?? [];
  const keyFields = schema.fields.filter((f) => f.key);
  const valueFields = schema.fields.filter((f) => !f.key);

  // H5: the keyTuple length MUST match the declared key fields exactly. A short
  // tuple was previously zero-filled — silently fabricating a (wrong) primary
  // key. A long tuple is an unknown/forged encoding. Reject either.
  if (keyTuple.length !== keyFields.length) {
    return null;
  }

  const key: Record<string, string | number | bigint | boolean | Hex> = {};
  for (let i = 0; i < keyFields.length; i++) {
    const f = keyFields[i] as IndexerTableSchema["fields"][number];
    key[f.name] = decodeKeyWord(keyTuple[i] as Hex, f.abiType);
  }

  const __block = Number(log.blockNumber);
  const __logIndex = log.logIndex;

  if (decoded.eventName === "Store_DeleteRecord") {
    return { type: "delete", table: schema.table, key };
  }

  // Store_SetRecord — decode the value fields. Static (fixed-size) fields come
  // from `staticData`; dynamic fields (string/bytes/arrays) come from
  // `dynamicData`. Each is ABI-tuple-encoded in declared order (matching the
  // World.sol `setRecord(tableId, key, staticData, dynamicData)` writer).
  const staticData = (decoded.args.staticData as Hex) ?? "0x";
  const dynamicData = (decoded.args.dynamicData as Hex) ?? "0x";
  const staticFields = valueFields.filter((f) => !isDynamicAbiType(f.abiType));
  const dynamicFields = valueFields.filter((f) => isDynamicAbiType(f.abiType));

  // H5: validate the staticData length matches the schema's static word count.
  // In an ABI tuple of fixed-size types each field is exactly one 32-byte word.
  // A length mismatch means the on-chain encoding does not match our schema —
  // reject rather than mis-decode / zero-fill.
  const expectedStaticBytes = staticFields.length * 32;
  const staticByteLen = hexByteLength(staticData);
  if (staticByteLen !== expectedStaticBytes) {
    return null;
  }

  // H5: if the schema declares dynamic fields, decode them from dynamicData
  // (previously ignored, which dropped/zero-filled them). If dynamicData is
  // absent for a schema that requires it, reject.
  if (dynamicFields.length > 0 && dynamicData === "0x") {
    return null;
  }

  let staticValues: readonly unknown[];
  try {
    staticValues =
      staticFields.length > 0
        ? decodeAbiParameters(
            staticFields.map((f) => ({ name: f.name, type: f.abiType })),
            staticData,
          )
        : [];
  } catch {
    return null;
  }

  let dynamicValues: readonly unknown[];
  try {
    dynamicValues =
      dynamicFields.length > 0
        ? decodeAbiParameters(
            dynamicFields.map((f) => ({ name: f.name, type: f.abiType })),
            dynamicData,
          )
        : [];
  } catch {
    return null;
  }

  const row: Record<string, unknown> = { ...key, __block, __logIndex };
  staticFields.forEach((f, i) => {
    row[f.name] = normalize(staticValues[i], f.abiType);
  });
  dynamicFields.forEach((f, i) => {
    row[f.name] = normalize(dynamicValues[i], f.abiType);
  });

  return { type: "set", table: schema.table, key, row: row as never };
}

/** True for ABI types whose encoding is variable-length (dynamic). */
function isDynamicAbiType(abiType: string): boolean {
  if (abiType === "string" || abiType === "bytes") return true;
  // Any array (`T[]` or `T[][]`) is dynamic; fixed-size `bytesN` is NOT.
  if (abiType.endsWith("]")) return true;
  return false;
}

/** Byte length of a `0x`-prefixed hex string. */
function hexByteLength(hex: string): number {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Math.floor(body.length / 2);
}

/** Decode a single bytes32 key word into the field's JS shape. */
function decodeKeyWord(word: Hex, abiType: string): string | number | bigint | boolean | Hex {
  if (abiType === "address") {
    return `0x${word.slice(-40)}`.toLowerCase() as Hex;
  }
  if (abiType.startsWith("uint") || abiType.startsWith("int")) {
    return BigInt(word);
  }
  if (abiType === "bool") {
    return BigInt(word) !== 0n;
  }
  return word; // bytes32 / bytes / string keys stay hex
}

/** Normalize a viem-decoded value to the wire shape we project. */
function normalize(v: unknown, abiType: string): unknown {
  if (abiType === "address" && typeof v === "string") return v.toLowerCase();
  return v;
}
