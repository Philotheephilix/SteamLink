// ── provider ──
export { NexusProvider } from "./provider/NexusProvider.js";
export type { NexusProviderProps } from "./provider/NexusProvider.js";
export { NexusContext } from "./provider/context.js";
export type { NexusClientConfig, NexusContextValue } from "./provider/context.js";
export { SubscriptionManager } from "./provider/SubscriptionManager.js";
export type { ManagerStatus } from "./provider/SubscriptionManager.js";

// ── transport seam ──
export type { Transport, Row, Where, TurnSnapshot, SubmitRequest } from "./transport.js";

// ── optimistic engine ──
export { OverlayStore, queryKey } from "./optimistic/store.js";
export type { Overlay } from "./optimistic/store.js";
export { reconcile } from "./optimistic/reconcile.js";
export type { StatusEvent, PendingResolver } from "./optimistic/reconcile.js";

// ── hooks ──
export { useNexus } from "./hooks/useNexus.js";
export { useTable } from "./hooks/useTable.js";
export type { UseTableResult } from "./hooks/useTable.js";
export { useTurn } from "./hooks/useTurn.js";
export type { UseTurnResult } from "./hooks/useTurn.js";
export { useSession } from "./hooks/useSession.js";
export type { Session, SessionPerms, UseSessionResult } from "./hooks/useSession.js";
export { useGameActions } from "./hooks/useGameActions.js";
export type {
  UseGameActionsResult,
  MoveOptions,
  MovePlan,
  MoveResult,
} from "./hooks/useGameActions.js";
export { useCharge } from "./hooks/useCharge.js";
export type { UseChargeResult, ChargeRequest, ChargeResult } from "./hooks/useCharge.js";
export { usePot } from "./hooks/usePot.js";
export type { UsePotResult } from "./hooks/usePot.js";

// ── errors ──
export { toMessage, errorMeta } from "./error/toMessage.js";
export { NexusError } from "@nexus/types";
export type { NexusErrorCode } from "@nexus/types";
