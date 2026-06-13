import { type Hex, NexusError, type TokenSymbol } from "@nexus/types";
import type {
  Challenge402,
  FacilitatorAdapter,
  PaymentRequest,
  Redemption,
  Settlement,
} from "./ports/facilitator.js";

/**
 * Options for {@link monetize} (design §7.3). `chain` is fixed to "base".
 * `facilitator` is either the literal "nexus" (selecting a `DelegationFacilitator`
 * supplied via {@link MonetizeRuntime}) or a concrete {@link FacilitatorAdapter}.
 */
export interface MonetizeOptions {
  price: string;
  token: TokenSymbol;
  chain: "base";
  recipient: Hex;
  facilitator: "nexus" | FacilitatorAdapter;
  /** Optional human label for the charge (passed through to the PaymentRequest). */
  reason?: string;
}

/**
 * Runtime dependencies the framework-agnostic core needs but the per-route
 * `opts` do not carry: the default facilitator selected by `facilitator:"nexus"`.
 */
export interface MonetizeRuntime {
  defaultFacilitator?: FacilitatorAdapter;
}

/**
 * The framework-neutral request view the core reads. Both the Hono and Express
 * adapters project their native request onto this shape.
 */
export interface MonetizeRequest {
  /** Parsed body of the incoming request (the redemption, when present). */
  body?: unknown;
  /** Header lookup (case-insensitive by convention). */
  header(name: string): string | undefined;
  /**
   * The authenticated payer (player's smart account), resolved by the Gateway's
   * auth layer. The challenge binds its nonce to this payer; `verify()` later
   * confirms the on-chain transfer originates from it.
   */
  payer?: Hex;
}

/** Header carrying the payer address, by convention (set by the auth layer). */
export const PAYER_HEADER = "x-payer";

const ZERO_PAYER = `0x${"0".repeat(40)}` as Hex;

/** A 402 outcome: emit the challenge body with HTTP 402. */
export interface Challenge402Result {
  kind: "challenge";
  status: 402;
  body: Challenge402;
}

/** A rejection outcome: a mapped NexusError with an HTTP status. */
export interface RejectResult {
  kind: "reject";
  status: number;
  body: ReturnType<NexusError["toJSON"]>;
  error: NexusError;
}

/** A pass outcome: the redemption verified; the route may run. */
export interface PassResult {
  kind: "pass";
  settlement: Settlement;
}

export type MonetizeResult = Challenge402Result | RejectResult | PassResult;

/** Header carrying the x402 redemption JSON, by convention. */
export const PAYMENT_HEADER = "x-payment";

function resolveFacilitator(opts: MonetizeOptions, runtime: MonetizeRuntime): FacilitatorAdapter {
  if (opts.facilitator === "nexus") {
    if (!runtime.defaultFacilitator) {
      throw new NexusError(
        "INVALID_CONFIG",
        'facilitator:"nexus" requires a defaultFacilitator in the monetize runtime',
      );
    }
    return runtime.defaultFacilitator;
  }
  return opts.facilitator;
}

/** Extract a redemption from the payment header or request body, if any. */
function extractRedemption(req: MonetizeRequest): Redemption | undefined {
  const raw = req.header(PAYMENT_HEADER);
  let candidate: unknown;
  if (raw) {
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new NexusError("PAYMENT_REQUIRED", "malformed x-payment header");
    }
  } else if (req.body && typeof req.body === "object" && "redemption" in req.body) {
    candidate = (req.body as { redemption: unknown }).redemption;
  } else {
    return undefined;
  }
  const r = candidate as Partial<Redemption> | undefined;
  if (!r || typeof r.nonce !== "string" || typeof r.delegationContext !== "string") {
    return undefined;
  }
  return r as Redemption;
}

/** Map a NexusError to the HTTP status the middleware should respond with. */
export function statusForError(err: NexusError): number {
  switch (err.code) {
    case "RECIPIENT_NOT_ALLOWED":
    case "BUDGET_EXCEEDED":
    case "DELEGATION_EXPIRED":
      return 403;
    case "PAYMENT_REQUIRED":
    case "NONCE_REUSED":
    case "SETTLEMENT_FAILED":
      return 402;
    case "INVALID_CONFIG":
      return 500;
    default:
      return 402;
  }
}

/**
 * The framework-agnostic monetize handler (design §7.3). It:
 *  - issues a 402 with the {@link Challenge402} when no redemption is present;
 *  - verifies a present redemption on Base via the facilitator and, on success,
 *    returns a `pass` with the `Settlement` so the adapter can run the route;
 *  - returns a mapped `reject` on any facilitator failure.
 *
 * It performs no I/O of its own beyond the facilitator calls, so it is reused
 * verbatim by the Hono and Express adapters.
 */
export async function createMonetizeHandler(
  opts: MonetizeOptions,
  runtime: MonetizeRuntime = {},
): Promise<(req: MonetizeRequest) => Promise<MonetizeResult>> {
  if (opts.chain !== "base") {
    throw new NexusError("INVALID_CONFIG", `monetize chain must be "base", got ${opts.chain}`);
  }
  const facilitator = resolveFacilitator(opts, runtime);

  return async (req: MonetizeRequest): Promise<MonetizeResult> => {
    let redemption: Redemption | undefined;
    try {
      redemption = extractRedemption(req);
    } catch (err) {
      const e = err instanceof NexusError ? err : new NexusError("PAYMENT_REQUIRED", String(err));
      return { kind: "reject", status: statusForError(e), body: e.toJSON(), error: e };
    }

    // No redemption → issue the 402 challenge.
    if (!redemption) {
      const paymentReq: PaymentRequest = {
        amount: opts.price,
        token: opts.token,
        recipient: opts.recipient,
        reason: opts.reason,
        // Payer comes from the auth layer (header or resolved context). The
        // challenge binds its nonce to this payer; verify() asserts the on-chain
        // Transfer originates from it.
        payer: req.payer ?? (req.header(PAYER_HEADER) as Hex | undefined) ?? ZERO_PAYER,
      };
      const body = await facilitator.challenge(paymentReq);
      return { kind: "challenge", status: 402, body };
    }

    // Redemption present → verify on Base and gate the route.
    try {
      const settlement = await facilitator.verify(redemption);
      return { kind: "pass", settlement };
    } catch (err) {
      const e =
        err instanceof NexusError
          ? err
          : new NexusError("SETTLEMENT_FAILED", `verify failed: ${String(err)}`, { cause: err });
      return { kind: "reject", status: statusForError(e), body: e.toJSON(), error: e };
    }
  };
}
