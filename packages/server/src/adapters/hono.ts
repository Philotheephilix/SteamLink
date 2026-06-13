import type { Hex } from "@nexus/types";
import {
  type MonetizeOptions,
  type MonetizeRequest,
  type MonetizeRuntime,
  createMonetizeHandler,
} from "../monetize.js";

/**
 * Minimal structural types for a Hono context so this adapter does not take a
 * hard dependency on `hono`. They match the subset of the Hono API used here.
 */
export interface HonoContextLike {
  req: {
    header(name: string): string | undefined;
    json(): Promise<unknown>;
  };
  /** Hono's per-request store; the settlement is stashed here on success. */
  set(key: "settlement", value: unknown): void;
  get(key: "payer"): Hex | undefined;
  json(body: unknown, status?: number): Response;
}

export type HonoNext = () => Promise<void>;

export type HonoMiddleware = (c: HonoContextLike, next: HonoNext) => Promise<Response | undefined>;

async function toMonetizeRequest(c: HonoContextLike): Promise<MonetizeRequest> {
  let body: unknown;
  // Body is only needed when no x-payment header is present; read defensively.
  if (!c.req.header("x-payment")) {
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
  }
  return {
    body,
    payer: c.get("payer"),
    header: (name: string) => c.req.header(name),
  };
}

/**
 * `monetize()` as Hono middleware (design §7.3). On a missing/invalid payment it
 * returns a `402` JSON {@link import("../ports/facilitator.js").Challenge402}; on
 * a verified redemption it stashes the settlement via `c.set("settlement", …)`
 * and calls `next()`; on a failed verification it returns the mapped error.
 */
export function monetizeHono(opts: MonetizeOptions, runtime: MonetizeRuntime = {}): HonoMiddleware {
  const handlerPromise = createMonetizeHandler(opts, runtime);
  return async (c, next) => {
    const handle = await handlerPromise;
    const result = await handle(await toMonetizeRequest(c));
    switch (result.kind) {
      case "challenge":
        return c.json(result.body, result.status);
      case "reject":
        return c.json(result.body, result.status);
      case "pass":
        c.set("settlement", result.settlement);
        await next();
        return;
    }
  };
}
