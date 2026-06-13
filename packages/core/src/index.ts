export { t } from "./schema/types.js";
export type {
  FieldKind,
  FieldType,
  TableSchema,
  RowOf,
  JsTypeOf,
  TDsl,
} from "./schema/types.js";

export { defineGame } from "./schema/defineGame.js";
export type {
  GameDefinition,
  EconomyConfig,
  SystemNames,
  TableNames,
} from "./schema/defineGame.js";

export { buildManifest, resourceId } from "./codegen/manifest.js";
export type {
  DeployManifest,
  ManifestTable,
  ManifestSystem,
  ManifestField,
} from "./codegen/manifest.js";
export { generateSolidityTables } from "./codegen/solidity.js";

// re-export the shared error/type surface for convenience
export { NexusError } from "@nexus/types";
export type { NexusErrorCode } from "@nexus/types";
