// ── facilitator port ──
export type {
  FacilitatorAdapter,
  PaymentRequest,
  Challenge402,
  Redemption,
  Settlement,
} from "./ports/facilitator.js";

// ── default delegation-aware facilitator ──
export { DelegationFacilitator } from "./facilitator/delegation-facilitator.js";
export type { DelegationFacilitatorConfig } from "./facilitator/delegation-facilitator.js";

// ── settlement verification (real on-chain read; client injected for tests) ──
export { verifyTransferOnChain } from "./facilitator/verify.js";
export type {
  ReceiptReaderClient,
  TransactionReceiptLike,
  LogLike,
  VerifyTransferParams,
} from "./facilitator/verify.js";

// ── nonce store (replay protection) ──
export {
  InMemoryNonceStore,
  randomNonce,
  DEFAULT_NONCE_TTL_MS,
} from "./facilitator/nonce-store.js";
export type { NonceStore, NonceRecord } from "./facilitator/nonce-store.js";

// ── framework-agnostic monetize core ──
export {
  createMonetizeHandler,
  statusForError,
  PAYMENT_HEADER,
  PAYER_HEADER,
} from "./monetize.js";
export type {
  MonetizeOptions,
  MonetizeRuntime,
  MonetizeRequest,
  MonetizeResult,
  Challenge402Result,
  RejectResult,
  PassResult,
} from "./monetize.js";

// ── framework adapters ──
export { monetizeExpress } from "./adapters/express.js";
export type {
  ExpressMiddleware,
  ExpressRequestLike,
  ExpressResponseLike,
  ExpressNext,
} from "./adapters/express.js";
export { monetizeHono } from "./adapters/hono.js";
export type { HonoMiddleware, HonoContextLike, HonoNext } from "./adapters/hono.js";

// `monetize` is the canonical name from design §7.3; defaults to the Express
// adapter (the design's primary `app.post(..., monetize({...}))` example).
export { monetizeExpress as monetize } from "./adapters/express.js";
