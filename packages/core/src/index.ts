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
export { generateSolidityTables, solidityLibraryName } from "./codegen/solidity.js";

// ── delegation engine ──
export {
  buildGameplayCaveats,
  buildBudgetCaveats,
  signDelegation,
  encodePermissionContext,
  encodeExecution,
  buildMoveExecution,
  buildChargeExecution,
  buildChargeFromExecution,
  buildRedeemCalldata,
  usdcToWei,
  MANAGER_ABI,
} from "./delegation/engine.js";
export type {
  Caveat,
  UnsignedDelegation,
  SignedDelegation,
  GameDelegationConfig,
  DeploymentAddresses,
} from "./delegation/types.js";
export {
  DELEGATION_TYPES,
  ROOT_AUTHORITY,
  eip712Domain,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
} from "./delegation/eip712.js";

// ── randomness facade (design §9, phase-09) ──
export {
  random,
  dice,
  commitmentFor,
  commitRevealCommit,
  commitRevealReveal,
  fastCalldata,
  RANDOMNESS_COORDINATOR_ABI,
} from "./randomness/index.js";
export type { RngTier, RandomnessCall, CommitRevealOpts } from "./randomness/index.js";

// re-export the shared error/type surface for convenience
export { NexusError } from "@nexus/types";
export type { NexusErrorCode } from "@nexus/types";
