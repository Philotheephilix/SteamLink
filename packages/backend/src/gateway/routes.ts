import { type Address, NexusError, asAddress } from "@nexus/types";
import type { Backend } from "../compose/createBackend.js";
import { errorResponse } from "../errors.js";
import { handleCharge } from "../lifecycles/charge.js";
import { handleMove } from "../lifecycles/move.js";
import type { WebhookPayload } from "../lifecycles/webhook.js";
import type { Where } from "../ports/indexer.js";
import { healthz, readyz } from "./health.js";

/**
 * The framework-agnostic route handlers (backend spec §4.1, phase-05 §4.1 — the
 * EXHAUSTIVE route table, nothing more). `createGatewayApp` adapts these to Hono;
 * keeping them here lets serverless mounts call them directly.
 */

export interface RouteResult {
  status: number;
  body: unknown;
}

function game(backend: Backend, name: string) {
  const g = backend.games.get(name);
  if (!g) throw new NexusError("INVALID_CONFIG", `GAME_NOT_FOUND: ${name}`);
  return g;
}

/** POST /game/:name/join → RoomService.joinRoom (validates caveats). */
export async function routeJoin(
  backend: Backend,
  name: string,
  body: { roomId: string; delegation: unknown },
  caller?: Address,
): Promise<RouteResult> {
  game(backend, name);
  // The body carries the signed GameDelegation; we trust the structural shape and
  // let `validateCaveats` reject anything unsafe.
  const delegation = body.delegation as { player?: Address } | undefined;
  // C5: when auth is active the verified signer MUST be the delegation's player —
  // you cannot enroll a victim's delegation under your own session.
  if (caller && delegation?.player && delegation.player.toLowerCase() !== caller.toLowerCase()) {
    throw new NexusError("NOT_CONNECTED", "verified caller is not the delegation player");
  }
  const session = await backend.rooms.joinRoom(body.roomId, body.delegation as never);
  return {
    status: 200,
    body: {
      sessionId: session.sessionId,
      roomId: session.roomId,
      player: session.player,
      state: backend.rooms.state(session.roomId),
    },
  };
}

/** POST /game/:name/move → move lifecycle → Relayer.submitBundle. */
export async function routeMove(
  backend: Backend,
  name: string,
  body: {
    sessionId: string;
    caller: Address;
    encodedExecution?: `0x${string}`;
    encodedTxns?: never;
  },
): Promise<RouteResult> {
  game(backend, name);
  const accepted = await handleMove(
    {
      game: name,
      sessionId: body.sessionId,
      caller: asAddress(body.caller),
      encodedExecution: body.encodedExecution,
      encodedTxns: body.encodedTxns,
    },
    {
      rooms: backend.rooms,
      store: backend.store,
      relayer: backend.relayer,
      awaiting: backend.awaiting,
      ledger: backend.ledger,
      webhookUrl: backend.webhookUrl,
    },
  );
  return { status: 202, body: accepted };
}

/** POST /game/:name/charge → charge lifecycle → Facilitator + Relayer. */
export async function routeCharge(
  backend: Backend,
  name: string,
  body: { sessionId: string; caller: Address; amount: string; to: Address; reason?: string },
): Promise<RouteResult> {
  game(backend, name);
  const accepted = await handleCharge(
    {
      game: name,
      sessionId: body.sessionId,
      caller: asAddress(body.caller),
      amount: body.amount,
      to: asAddress(body.to),
      reason: body.reason,
    },
    {
      rooms: backend.rooms,
      store: backend.store,
      relayer: backend.relayer,
      facilitator: backend.facilitator,
      awaiting: backend.awaiting,
      ledger: backend.ledger,
      webhookUrl: backend.webhookUrl,
    },
  );
  // Per x402: the charge route surfaces the 402 challenge. The SDK has a session
  // delegation, so we submit immediately and return 202 with the challenge body.
  return { status: 202, body: accepted };
}

/** GET /game/:name/state/:table → IndexerAdapter.query. */
export async function routeState(
  backend: Backend,
  name: string,
  table: string,
  where: Where,
): Promise<RouteResult> {
  const g = game(backend, name);
  if (!(table in g.tables)) {
    return { status: 404, body: { error: { code: "UNKNOWN_TABLE", message: table } } };
  }
  const rows = await backend.indexer.query(table, where);
  return { status: 200, body: rows };
}

/** POST /nexus/webhook → WebhookHandler.ingest. */
export async function routeWebhook(
  backend: Backend,
  payload: WebhookPayload,
  headers: Record<string, string>,
  rawBody?: string,
): Promise<RouteResult> {
  // Thread the RAW body so the HMAC verifier checks the exact signed bytes (C2).
  const result = await backend.webhook.ingest(payload, headers, rawBody);
  return { status: 200, body: result };
}

export function routeHealthz(): RouteResult {
  return { status: 200, body: healthz() };
}

export async function routeReadyz(backend: Backend): Promise<RouteResult> {
  // Duck-type the indexer's optional `ready` flag: adapters that don't expose one
  // are treated as ready (() => true) rather than blocking readiness checks.
  const indexerReady =
    "ready" in backend.indexer &&
    typeof (backend.indexer as { ready?: unknown }).ready === "boolean"
      ? () => (backend.indexer as unknown as { ready: boolean }).ready
      : () => true;
  const dto = await readyz({
    relayer: backend.relayer,
    indexerReady,
    sessionStoreReachable: async () => {
      await backend.store.get("__probe__");
      return true;
    },
  });
  return { status: dto.ready ? 200 : 503, body: dto };
}

export { errorResponse };
