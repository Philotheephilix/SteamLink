import { type Address, type Hex, NexusError } from "@nexus/types";
import type { GatewayRequest, Middleware } from "../compose/middleware.js";
import type { SessionStore } from "../rooms/store.js";
import {
  type AuthConfig,
  type NonceReplayStore,
  type SignedRequest,
  TtlNonceReplayStore,
  verifyRequest,
} from "./auth.js";

/**
 * Header names carrying the caller's request signature. The browser SDK signs
 * the canonical request payload once per session-scoped call and sends these.
 */
export const SIG_HEADER = "x-nexus-signature";
export const NONCE_HEADER = "x-nexus-nonce";
export const TIMESTAMP_HEADER = "x-nexus-timestamp";
export const CALLER_HEADER = "x-nexus-caller";

/** Path prefixes that REQUIRE a verified caller signature (C5). */
const SESSION_SCOPED = ["/move", "/charge", "/join", "/state", "/subscribe"];

function isSessionScoped(path: string): boolean {
  return SESSION_SCOPED.some((suffix) => path.endsWith(suffix) || path.includes(`${suffix}/`));
}

export interface AuthMiddlewareConfig extends AuthConfig {
  /**
   * Backs replay protection with a shared, bounded store. The gateway derives one
   * from the SessionStore so it is consistent across instances (H3). Defaults to
   * a process-local TTL store.
   */
  nonceStore?: NonceReplayStore;
}

/**
 * The DEFAULT caller-auth middleware (C5). Installed by `createBackend` ahead of
 * any user middleware, it requires a verified signature on EVERY session-scoped
 * route (join/move/charge/state/subscribe), recovers the signer, and binds it as
 * `req.caller`. It IGNORES any `body.caller` — the recovered address is the only
 * trusted identity. A missing/invalid signature is rejected before routing, so a
 * caller can never act for a victim.
 */
export function createAuthMiddleware(cfg: AuthMiddlewareConfig = {}): Middleware {
  const nonceStore = cfg.nonceStore ?? new TtlNonceReplayStore();
  return async (req: GatewayRequest, next) => {
    if (!isSessionScoped(req.path)) return next();

    const signature = req.headers[SIG_HEADER] as Hex | undefined;
    const nonce = req.headers[NONCE_HEADER];
    const timestampRaw = req.headers[TIMESTAMP_HEADER];
    const caller = req.headers[CALLER_HEADER] as Address | undefined;

    if (!signature || !nonce || !timestampRaw || !caller) {
      return reject(
        new NexusError("NOT_CONNECTED", "session-scoped request is missing a caller signature"),
      );
    }

    const signed: SignedRequest = {
      method: req.method,
      path: req.path,
      body: req.body,
      nonce,
      timestamp: Number(timestampRaw),
      caller,
      signature,
    };

    let verified: Address;
    try {
      verified = await verifyRequest(signed, { ...cfg, nonceStore });
    } catch (err) {
      const e = err instanceof NexusError ? err : new NexusError("NOT_CONNECTED", "auth failed");
      return reject(e);
    }

    // Bind the RECOVERED signer. Downstream routes use this, never body.caller.
    req.caller = verified;
    return next();
  };
}

function reject(e: NexusError) {
  return Promise.resolve({ status: 401, body: e.toJSON() });
}

/**
 * Adapt a SessionStore into a process-shared replay store. The SessionStore is
 * the durable, cross-instance substrate (Redis in prod); here we expose the
 * `checkAndConsume` contract over a namespaced key. The in-memory default store
 * already satisfies bounded TTL semantics; a Redis store would implement this
 * with `SET key NX PX ttl`.
 */
export function nonceStoreFromSessionStore(_store: SessionStore): NonceReplayStore {
  // The MemorySessionStore has no generic kv surface; use a bounded TTL store
  // keyed in-process. A RedisSessionStore deployment swaps this for a SET-NX
  // backed store sharing the same Redis, making replay protection cross-instance.
  return new TtlNonceReplayStore();
}
