import type { Hex } from "@nexus/types";
import {
  type MonetizeOptions,
  type MonetizeRequest,
  type MonetizeRuntime,
  createMonetizeHandler,
} from "../monetize.js";
import type { Settlement } from "../ports/facilitator.js";

/**
 * Minimal structural types for Express req/res so this adapter does not take a
 * hard dependency on `express` (kept as a peer in real deployments). They match
 * the subset of the Express API the middleware uses.
 */
export interface ExpressRequestLike {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Populated by an upstream auth layer, if present. */
  payer?: Hex;
  /** Attached on success so the route handler can read the settlement. */
  settlement?: Settlement;
}

export interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  json(body: unknown): unknown;
}

export type ExpressNext = (err?: unknown) => void;

export type ExpressMiddleware = (
  req: ExpressRequestLike,
  res: ExpressResponseLike,
  next: ExpressNext,
) => void | Promise<void>;

function toMonetizeRequest(req: ExpressRequestLike): MonetizeRequest {
  return {
    body: req.body,
    payer: req.payer,
    header(name: string) {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
  };
}

/**
 * `monetize()` as Express middleware (design §7.3). On a missing/invalid payment
 * it responds `402` with the {@link import("../ports/facilitator.js").Challenge402};
 * on a verified redemption it attaches `req.settlement` and calls `next()`; on a
 * failed verification it responds with the mapped `NexusError` status.
 */
export function monetizeExpress(
  opts: MonetizeOptions,
  runtime: MonetizeRuntime = {},
): ExpressMiddleware {
  const handlerPromise = createMonetizeHandler(opts, runtime);
  return async (req, res, next) => {
    try {
      const handle = await handlerPromise;
      const result = await handle(toMonetizeRequest(req));
      switch (result.kind) {
        case "challenge":
          res.status(result.status).json(result.body);
          return;
        case "reject":
          res.status(result.status).json(result.body);
          return;
        case "pass":
          req.settlement = result.settlement;
          next();
          return;
      }
    } catch (err) {
      next(err);
    }
  };
}
