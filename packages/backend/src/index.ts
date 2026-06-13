// ── composition root ──
export { createBackend } from "./compose/createBackend.js";
export type { Backend, BackendOptions } from "./compose/createBackend.js";
export { defineBackend } from "./compose/defineBackend.js";
export type { BackendConfig } from "./compose/defineBackend.js";
export {
  defaultIndexer,
  defaultSessionStore,
  defaultFacilitator,
  requireRelayer,
} from "./compose/defaults.js";
export { indexGames, toIndexerSchema, allIndexerSchemas } from "./compose/discover.js";
export {
  composeMiddleware,
  rateLimit,
} from "./compose/middleware.js";
export type { Middleware, GatewayRequest, GatewayResponse } from "./compose/middleware.js";

// ── gateway ──
export { createGatewayApp } from "./gateway/server.js";
export {
  routeJoin,
  routeMove,
  routeCharge,
  routeState,
  routeWebhook,
  routeHealthz,
  routeReadyz,
} from "./gateway/routes.js";
export {
  verifyRequest,
  canonicalMessage,
  TtlNonceReplayStore,
  DEFAULT_NONCE_REPLAY_TTL_MS,
} from "./gateway/auth.js";
export type { SignedRequest, AuthConfig, NonceReplayStore } from "./gateway/auth.js";
export {
  createAuthMiddleware,
  nonceStoreFromSessionStore,
  SIG_HEADER,
  NONCE_HEADER,
  TIMESTAMP_HEADER,
  CALLER_HEADER,
} from "./gateway/auth-middleware.js";
export type { AuthMiddlewareConfig } from "./gateway/auth-middleware.js";
export { WsHub } from "./gateway/ws.js";
export type { ClientFrame, ServerFrame, SocketSink } from "./gateway/ws.js";
export { healthz, readyz } from "./gateway/health.js";
export type { HealthDTO, ReadyDTO } from "./gateway/health.js";

// ── rooms / sessions ──
export { RoomService } from "./rooms/RoomService.js";
export type { RoomServiceDeps } from "./rooms/RoomService.js";
export { MemorySessionStore } from "./rooms/store.js";
export type { SessionStore } from "./rooms/store.js";
export {
  validateCaveats,
  DEFAULT_CAVEAT_POLICY,
} from "./rooms/caveats.js";
export type { CaveatPolicy } from "./rooms/caveats.js";
export {
  transition,
  canTransition,
  assertCanJoin,
  assertActive,
  assertSettling,
} from "./rooms/lifecycle.js";
export type { RoomEvent } from "./rooms/lifecycle.js";

// ── pots ──
export { PotService } from "./pots/PotService.js";
export type { PotServiceDeps } from "./pots/PotService.js";
export { computePayout, computeRefunds, rakeFraction, rakeBps } from "./pots/rake.js";
export type { PayoutSplit, RefundShare } from "./pots/rake.js";

// ── lifecycles ──
export { handleMove } from "./lifecycles/move.js";
export type { MoveRequest, MoveDeps, Accepted } from "./lifecycles/move.js";
export { handleCharge } from "./lifecycles/charge.js";
export type { ChargeRequest, ChargeDeps, ChargeAccepted } from "./lifecycles/charge.js";
export { AwaitingRegistry } from "./lifecycles/awaiting.js";
export type { AwaitingResolution } from "./lifecycles/awaiting.js";
export {
  WebhookHandler,
  MemoryWebhookLedger,
  hmacWebhookVerifier,
  signWebhookBody,
  WEBHOOK_SIG_HEADER,
} from "./lifecycles/webhook.js";
export type {
  WebhookLedger,
  WebhookPayload,
  WebhookVerifier,
  WebhookSettlementDeps,
  CorrelationRecord,
  IngestResult,
} from "./lifecycles/webhook.js";

// ── indexer ──
export { InMemoryIndexer } from "./indexer/memory-indexer.js";
export { NexusIndexer } from "./indexer/nexus-indexer.js";
export type { NexusIndexerConfig } from "./indexer/nexus-indexer.js";
export {
  decodeStoreLog,
  buildTableRegistry,
  STORE_EVENTS_ABI,
  STORE_SET_RECORD,
  STORE_DELETE_RECORD,
} from "./indexer/decode.js";
export type { RawLog } from "./indexer/decode.js";

// ── ports ──
export type {
  IndexerAdapter,
  IndexerConfig,
  IndexerGameSchema,
  IndexerTableSchema,
  IndexerField,
  Row,
  RowChange,
  RowKey,
  Where,
  Unsubscribe,
} from "./ports/indexer.js";
export { StubFacilitator, DelegationFacilitator } from "./ports/facilitator.js";
export type {
  FacilitatorAdapter,
  PaymentRequest,
  Challenge402,
  Redemption,
  Settlement,
} from "./ports/facilitator.js";

// ── shared types + errors ──
export type {
  GameModule,
  RoomId,
  RoomState,
  Session,
  GameDelegation,
  RelayerRef,
  PotRef,
  RoomConfig,
  Refund,
  Payout,
} from "./types.js";
export { httpStatusForCode, errorResponse, NexusError } from "./errors.js";
