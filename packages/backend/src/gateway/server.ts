import { type Address, NexusError } from "@nexus/types";
import { type Context, Hono } from "hono";
import type { Backend } from "../compose/createBackend.js";
import type { GatewayRequest } from "../compose/middleware.js";
import { errorResponse } from "../errors.js";
import type { Where } from "../ports/indexer.js";
import {
  routeCharge,
  routeHealthz,
  routeJoin,
  routeMove,
  routeReadyz,
  routeState,
  routeWebhook,
} from "./routes.js";

/**
 * The Hono app factory (phase-05 §4.1). Exposes EXACTLY the backend spec §4.1
 * routes — no more. The gateway is stateless; any instance serves any request.
 * Session-scoped routes run the middleware pipeline (auth runs first when an auth
 * middleware is registered) before the terminal handler.
 *
 *   POST /game/:name/join          → RoomService.joinRoom
 *   POST /game/:name/move          → move lifecycle → Relayer.submitBundle
 *   POST /game/:name/charge        → charge lifecycle → Facilitator + Relayer
 *   GET  /game/:name/state/:table  → IndexerAdapter.query
 *   WS   /game/:name/subscribe     → IndexerAdapter.subscribe push (WsHub)
 *   POST /nexus/webhook            → WebhookHandler.ingest
 *   GET  /healthz /readyz          → ops
 */
export function createGatewayApp(backend: Backend): Hono {
  const app = new Hono();

  // Run the registered middleware pipeline (auth first) around a terminal
  // handler. The terminal receives the PIPELINE request so it can read the
  // auth-bound `req.caller` (the recovered signer) — never trusting body.caller.
  const withPipeline = async (
    c: Context,
    redemption: GatewayRequest["redemption"],
    terminal: (req: GatewayRequest) => Promise<{ status: number; body: unknown }>,
  ) => {
    const body = await c.req.json().catch(() => ({}));
    const req: GatewayRequest = {
      method: c.req.method,
      path: c.req.path,
      params: c.req.param() as Record<string, string>,
      query: c.req.query() as Record<string, string>,
      body,
      headers: Object.fromEntries(
        // biome-ignore lint/suspicious/noExplicitAny: Hono header iteration
        [...(c.req.raw.headers as any)] as [string, string][],
      ),
      redemption,
    };
    const result = await backend.runPipeline(req, async (r) => {
      const out = await terminal(r);
      return { status: out.status, body: out.body };
    });
    return c.json(result.body as never, result.status as never);
  };

  app.post("/game/:name/join", async (c) => {
    const name = c.req.param("name");
    return withPipeline(c, undefined, async (req) => {
      try {
        const caller = requireCaller(req);
        const body = (await cloneBody(c)) as {
          roomId: string;
          delegation: unknown;
        };
        // C5: the signer must be the delegation's player — you cannot enroll a
        // victim's delegation under your own session.
        return await routeJoin(backend, name, body, caller);
      } catch (err) {
        return errorResponse(err);
      }
    });
  });

  app.post("/game/:name/move", async (c) => {
    const name = c.req.param("name");
    return withPipeline(c, { kind: "move" }, async (req) => {
      try {
        const body = (await cloneBody(c)) as Parameters<typeof routeMove>[2];
        // C5: the verified signer (req.caller) is the ONLY trusted caller.
        return await routeMove(backend, name, { ...body, caller: requireCaller(req) });
      } catch (err) {
        return errorResponse(err);
      }
    });
  });

  app.post("/game/:name/charge", async (c) => {
    const name = c.req.param("name");
    return withPipeline(c, { kind: "charge" }, async (req) => {
      try {
        const body = (await cloneBody(c)) as Parameters<typeof routeCharge>[2];
        // C5: the verified signer (req.caller) is the ONLY trusted caller.
        return await routeCharge(backend, name, { ...body, caller: requireCaller(req) });
      } catch (err) {
        return errorResponse(err);
      }
    });
  });

  app.get("/game/:name/state/:table", async (c) => {
    const name = c.req.param("name");
    const table = c.req.param("table");
    const where = c.req.query() as Where;
    // C5: state reads are session-scoped — run the auth pipeline first.
    return withPipeline(c, undefined, async (req) => {
      try {
        requireCaller(req);
        return await routeState(backend, name, table, where);
      } catch (err) {
        return errorResponse(err);
      }
    });
  });

  app.post("/nexus/webhook", async (c) => {
    try {
      // Read the RAW body so the HMAC is verified over the exact signed bytes
      // (C2/C3) — never re-serialized JSON.
      const rawBody = await c.req.text().catch(() => "");
      let payload: Parameters<typeof routeWebhook>[1];
      try {
        payload = JSON.parse(rawBody || "{}") as Parameters<typeof routeWebhook>[1];
      } catch {
        payload = {} as Parameters<typeof routeWebhook>[1];
      }
      const headers = Object.fromEntries(
        // biome-ignore lint/suspicious/noExplicitAny: Hono header iteration
        [...(c.req.raw.headers as any)] as [string, string][],
      );
      const r = await routeWebhook(backend, payload, headers, rawBody);
      return c.json(r.body as never, r.status as never);
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body as never, e.status as never);
    }
  });

  app.get("/healthz", (c) => {
    const r = routeHealthz();
    return c.json(r.body as never, r.status as never);
  });

  app.get("/readyz", async (c) => {
    const r = await routeReadyz(backend);
    return c.json(r.body as never, r.status as never);
  });

  return app;
}

/** Read the JSON body once; Hono caches it so a second `.json()` is safe. */
async function cloneBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

/**
 * Assert the auth middleware bound a verified caller and return it. Defense in
 * depth: if auth ever failed to run (it is installed by default), the route
 * fails closed rather than acting on an unauthenticated request (C5).
 */
function requireCaller(req: GatewayRequest): Address {
  if (!req.caller) {
    throw new NexusError("NOT_CONNECTED", "no verified caller bound — auth did not run");
  }
  return req.caller;
}
