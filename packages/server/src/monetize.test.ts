import { CHAINS, type Hex, NexusError, asAddress } from "@nexus/types";
import { describe, expect, it, vi } from "vitest";
import {
  type ExpressRequestLike,
  type ExpressResponseLike,
  monetizeExpress,
} from "./adapters/express.js";
import { type MonetizeRequest, PAYMENT_HEADER, createMonetizeHandler } from "./monetize.js";
import type {
  Challenge402,
  FacilitatorAdapter,
  PaymentRequest,
  Redemption,
  Settlement,
} from "./ports/facilitator.js";

const USDC = asAddress(CHAINS["base-sepolia"].usdc) as Hex;
const PAYER = asAddress("0x1111111111111111111111111111111111111111") as Hex;
const RECIPIENT = asAddress("0x2222222222222222222222222222222222222222") as Hex;
const TXHASH = `0x${"ab".repeat(32)}` as Hex;

/**
 * A FAKE facilitator injected via the runtime — the middleware's branching
 * (challenge vs verify vs reject) is the real logic under test; only the
 * facilitator is a fake (DI), per the task.
 */
function fakeFacilitator(overrides: Partial<FacilitatorAdapter> = {}): FacilitatorAdapter {
  const challenge = vi.fn(
    (req: PaymentRequest): Challenge402 => ({
      scheme: "x402",
      price: "5000000",
      token: USDC,
      tokenSymbol: "USDC",
      recipient: req.recipient,
      chain: "base",
      nonce: `0x${"11".repeat(32)}` as Hex,
      expiresAt: Date.now() + 60_000,
      facilitator: "nexus",
    }),
  );
  const verify = vi.fn(
    async (r: Redemption): Promise<Settlement> => ({
      nonce: r.nonce,
      txHash: TXHASH,
      blockNumber: 1,
      amount: "5000000",
      token: USDC,
      from: PAYER,
      to: RECIPIENT,
      status: "settled",
    }),
  );
  return { challenge, verify, ...overrides } as FacilitatorAdapter;
}

const OPTS = {
  price: "5",
  token: "USDC" as const,
  chain: "base" as const,
  recipient: RECIPIENT,
  facilitator: "nexus" as const,
};

function req(
  partial: Partial<MonetizeRequest> & { headers?: Record<string, string> },
): MonetizeRequest {
  const headers = partial.headers ?? {};
  return {
    body: partial.body,
    payer: partial.payer,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

describe("createMonetizeHandler", () => {
  it("issues a 402 challenge when no payment is present", async () => {
    const fac = fakeFacilitator();
    const handle = await createMonetizeHandler(OPTS, { defaultFacilitator: fac });
    const result = await handle(req({}));
    expect(result.kind).toBe("challenge");
    if (result.kind !== "challenge") throw new Error("unreachable");
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ scheme: "x402", chain: "base", facilitator: "nexus" });
    expect(fac.challenge).toHaveBeenCalledOnce();
  });

  it("passes (runs the route) when a valid redemption verifies", async () => {
    const fac = fakeFacilitator();
    const handle = await createMonetizeHandler(OPTS, { defaultFacilitator: fac });
    const redemption: Redemption = {
      nonce: `0x${"11".repeat(32)}` as Hex,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    const result = await handle(req({ headers: { [PAYMENT_HEADER]: JSON.stringify(redemption) } }));
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("unreachable");
    expect(result.settlement.status).toBe("settled");
    expect(fac.verify).toHaveBeenCalledOnce();
  });

  it("rejects with a mapped status when verify fails (e.g. replay)", async () => {
    const fac = fakeFacilitator({
      verify: vi.fn(async () => {
        throw new NexusError("NONCE_REUSED", "402 nonce already redeemed");
      }),
    });
    const handle = await createMonetizeHandler(OPTS, { defaultFacilitator: fac });
    const redemption: Redemption = {
      nonce: `0x${"11".repeat(32)}` as Hex,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    const result = await handle(req({ headers: { [PAYMENT_HEADER]: JSON.stringify(redemption) } }));
    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") throw new Error("unreachable");
    expect(result.status).toBe(402);
    expect(result.body.code).toBe("NONCE_REUSED");
  });

  it("maps BUDGET_EXCEEDED to 403", async () => {
    const fac = fakeFacilitator({
      verify: vi.fn(async () => {
        throw new NexusError("BUDGET_EXCEEDED", "over per-action cap");
      }),
    });
    const handle = await createMonetizeHandler(OPTS, { defaultFacilitator: fac });
    const redemption: Redemption = {
      nonce: `0x${"11".repeat(32)}` as Hex,
      payer: PAYER,
      delegationContext: "0xd" as Hex,
      txHash: TXHASH,
    };
    const result = await handle(req({ headers: { [PAYMENT_HEADER]: JSON.stringify(redemption) } }));
    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it('requires a defaultFacilitator when facilitator:"nexus"', async () => {
    await expect(createMonetizeHandler({ ...OPTS, facilitator: "nexus" })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("accepts a concrete facilitator passed directly in opts", async () => {
    const fac = fakeFacilitator();
    const handle = await createMonetizeHandler({ ...OPTS, facilitator: fac });
    const result = await handle(req({}));
    expect(result.kind).toBe("challenge");
  });
});

describe("monetizeExpress", () => {
  function res() {
    const calls: { status?: number; body?: unknown } = {};
    const r: ExpressResponseLike = {
      status(code: number) {
        calls.status = code;
        return r;
      },
      json(body: unknown) {
        calls.body = body;
        return body;
      },
    };
    return { r, calls };
  }

  it("responds 402 with the challenge body on a missing payment", async () => {
    const fac = fakeFacilitator();
    const mw = monetizeExpress({ ...OPTS, facilitator: "nexus" }, { defaultFacilitator: fac });
    const { r, calls } = res();
    const next = vi.fn();
    await mw({ headers: {} } as ExpressRequestLike, r, next);
    expect(calls.status).toBe(402);
    expect((calls.body as Challenge402).scheme).toBe("x402");
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.settlement and calls next() on a verified redemption", async () => {
    const fac = fakeFacilitator();
    const mw = monetizeExpress({ ...OPTS, facilitator: "nexus" }, { defaultFacilitator: fac });
    const { r, calls } = res();
    const next = vi.fn();
    const redemption: Redemption = {
      nonce: `0x${"11".repeat(32)}` as Hex,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    const request = {
      headers: { [PAYMENT_HEADER]: JSON.stringify(redemption) },
    } as unknown as ExpressRequestLike;
    await mw(request, r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(calls.status).toBeUndefined();
    expect(request.settlement?.status).toBe("settled");
  });
});
