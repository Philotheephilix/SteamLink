/**
 * The `t` field-type DSL used inside `defineGame({ tables })`. Each field type
 * carries (a) its Solidity type, (b) its ABI type for encoding, and (c) the
 * TypeScript type it maps to in the generated client. This single source of
 * truth drives both Solidity table codegen and TS type generation.
 */

export type FieldKind =
  | "address"
  | "bool"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "uint256"
  | "int8"
  | "int256"
  | "bytes32"
  | "bytes"
  | "string";

export interface FieldType<TKind extends FieldKind = FieldKind, TJs = unknown> {
  readonly kind: TKind;
  readonly solidityType: string;
  readonly abiType: string;
  /** Phantom marker for the mapped TS type; never present at runtime. */
  readonly __js?: TJs;
}

function field<TKind extends FieldKind, TJs>(
  kind: TKind,
  solidityType: string,
  abiType = solidityType,
): FieldType<TKind, TJs> {
  return { kind, solidityType, abiType };
}

/**
 * The field-type constructors. Numeric `uint`/`int` default to 256-bit but the
 * sized variants generate tighter Solidity storage.
 */
export const t = {
  address: field<"address", `0x${string}`>("address", "address"),
  bool: field<"bool", boolean>("bool", "bool"),
  uint: field<"uint256", bigint>("uint256", "uint256"),
  uint8: field<"uint8", number>("uint8", "uint8"),
  uint16: field<"uint16", number>("uint16", "uint16"),
  uint32: field<"uint32", number>("uint32", "uint32"),
  uint64: field<"uint64", bigint>("uint64", "uint64"),
  uint256: field<"uint256", bigint>("uint256", "uint256"),
  int8: field<"int8", number>("int8", "int8"),
  int: field<"int256", bigint>("int256", "int256"),
  bytes32: field<"bytes32", `0x${string}`>("bytes32", "bytes32"),
  bytes: field<"bytes", `0x${string}`>("bytes", "bytes"),
  string: field<"string", string>("string", "string"),
} as const;

export type TDsl = typeof t;

/** Map a FieldType to its TypeScript representation. */
export type JsTypeOf<F> = F extends FieldType<FieldKind, infer TJs> ? TJs : never;

/** A table schema: a record of column name -> field type. */
export type TableSchema = Record<string, FieldType>;

/** Map a whole table schema to the TS row shape. */
export type RowOf<S extends TableSchema> = {
  [K in keyof S]: JsTypeOf<S[K]>;
};
