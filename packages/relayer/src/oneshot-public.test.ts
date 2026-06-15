import { NexusError } from "@nexus/types";
import { describe, expect, it, vi } from "vitest";
import {
  OneShotPublicRelayer,
  RELAY_STATUS,
  mapStatus,
  ONESHOT_PUBLIC_RELAYER_TESTNET,
} from "./oneshot-public.js";
import type { FetchImpl, RelayStatusResult } from "./oneshot-public.js";
import type { Address } from "@nexus/types";
import type { Bundle, RelayDelegation, StatusEvent } from "./port.js";

const TARGET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FEE = "0xcccccccccccccccccccccccccccccccccccccccc";
const PLAYER = "0x1111111111111111111111111111111111111111";
const POT = "0x2222222222222222222222222222222222222222";

/** A capabilities result keyed by chain id, as the real relayer returns it. */
function capsResult(chainId = "84532") {
  return {
    [chainId]: {
      feeCollector: FEE,
      targetAddress: TARGET,
      tokens: [{ address: USDC, symbol: "USDC", decimals: "6" }],
    },
  };
}

/**
 * A fake `fetch` that speaks JSON-RPC: it parses the request body, dispatches by
 * `method`, and returns `{ jsonrpc, id, result|error }`. Routes are keyed by RPC
 * method name; each handler receives the params array.
 */
function rpcFetch(
  routes: Record<string, (params: unknown[]) => unknown>,
): { impl: FetchImpl; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const impl: FetchImpl = async (_url, init) => {
    const req = JSON.parse(init?.body ?? "{}") as { id: number; method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    const handler = routes[req.method];
    if (!handler) {
      return jsonRes({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no route" } });
    }
    const out = handler(req.params);
    if (out && typeof out === "object" && "__error" in (out as object)) {
      return jsonRes({ jsonrpc: "2.0", id: req.id, error: (out as { __error: unknown }).__error });
    }
    return jsonRes({ jsonrpc: "2.0", id: req.id, result: out });
  };
  return { impl, calls };
}

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function relayer(impl: FetchImpl, extra: Partial<Record<string, unknown>> = {}) {
  return new OneShotPublicRelayer({
    chainId: "84532",
    endpoint: ONESHOT_PUBLIC_RELAYER_TESTNET,
    fetchImpl: impl,
    pollIntervalMs: 1,
    ...extra,
  });
}

function delegation(delegate: Address = TARGET): RelayDelegation {
  return {
    delegate,
    delegator: PLAYER,
    authority: "0x0000000000000000000000000000000000000000000000000000000000000000",
    caveats: [{ enforcer: OTHER, terms: "0x", args: "0x" }],
    salt: "0x01",
    signature: "0xabc",
  };
}

function moveBundle(over: Partial<Bundle> = {}): Bundle {
  return {
    permissionContext: [delegation()],
    encodedTxns: [{ to: USDC, data: "0xdeadbeef" }],
    ...over,
  };
}

describe("OneShotPublicRelayer.getCapabilities", () => {
  it("parses the per-chain record into tokens/feeCollector/targetAddress and caches", async () => {
    const { impl, calls } = rpcFetch({ relayer_getCapabilities: () => capsResult() });
    const r = relayer(impl);

    const caps = await r.getCapabilities();
    expect(caps.chains).toEqual(["84532"]);
    expect(caps.tokens.USDC!.toLowerCase()).toBe(USDC.toLowerCase());
    expect(caps.targetAddress.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(caps.feeCollector.toLowerCase()).toBe(FEE.toLowerCase());

    await r.getCapabilities(); // cached — no second RPC
    expect(calls.filter((c) => c.method === "relayer_getCapabilities")).toHaveLength(1);
  });

  it("requests capabilities for the configured chain as a nested string array", async () => {
    const { impl, calls } = rpcFetch({ relayer_getCapabilities: () => capsResult() });
    await relayer(impl).getCapabilities();
    expect(calls[0]!.params).toEqual([["84532"]]);
  });

  it("throws CAPABILITIES_UNAVAILABLE when the chain is not served (empty result)", async () => {
    const { impl } = rpcFetch({ relayer_getCapabilities: () => ({}) });
    await expect(relayer(impl).getCapabilities()).rejects.toMatchObject({
      code: "CAPABILITIES_UNAVAILABLE",
    });
  });

  it("surfaces a JSON-RPC error as CAPABILITIES_UNAVAILABLE", async () => {
    const { impl } = rpcFetch({
      relayer_getCapabilities: () => ({ __error: { code: 4206, message: "Chain not supported" } }),
    });
    await expect(relayer(impl).getCapabilities()).rejects.toMatchObject({
      code: "CAPABILITIES_UNAVAILABLE",
    });
  });
});

describe("OneShotPublicRelayer.getFeeData", () => {
  it("calls relayer_getFeeData with { chainId, token } and returns the quote", async () => {
    const fee = {
      chainId: "84532",
      token: { address: USDC, decimals: 6, symbol: "USDC", name: "USD Coin" },
      rate: 2000.5,
      minFee: "4.5",
      expiry: 123,
      gasPrice: "0x1",
      feeCollector: FEE,
      targetAddress: TARGET,
      context: "{\"quote\":\"signed\"}",
    };
    const { impl, calls } = rpcFetch({ relayer_getFeeData: () => fee });
    const out = await relayer(impl).getFeeData(USDC);
    expect(out.minFee).toBe("4.5");
    expect(calls[0]!.params).toEqual([{ chainId: "84532", token: USDC }]);
  });
});

describe("OneShotPublicRelayer.submitBundle", () => {
  it("maps encodedTxns to executions and returns the TaskId", async () => {
    const { impl, calls } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "task_123",
      relayer_getStatus: () => statusAt(RELAY_STATUS.QUEUED),
    });
    const r = relayer(impl);
    const handle = await r.submitBundle(moveBundle());
    expect(handle.bundleId).toBe("task_123");

    const send = calls.find((c) => c.method === "relayer_send7710Transaction")!;
    const params = (send.params as [Record<string, unknown>])[0];
    expect(params.chainId).toBe("84532");
    const tx = (params.transactions as Record<string, unknown>[])[0]!;
    expect(tx.executions).toEqual([{ target: USDC, value: "0x0", data: "0xdeadbeef" }]);
    expect((tx.permissionContext as unknown[]).length).toBe(1);
  });

  it("encodes a bigint execution value as hex", async () => {
    const { impl, calls } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "t",
      relayer_getStatus: () => statusAt(RELAY_STATUS.QUEUED),
    });
    await relayer(impl).submitBundle(
      moveBundle({ encodedTxns: [{ to: POT, data: "0x", value: 255n }] }),
    );
    const send = calls.find((c) => c.method === "relayer_send7710Transaction")!;
    const tx = ((send.params as [Record<string, unknown>])[0].transactions as Record<string, unknown>[])[0]!;
    expect((tx.executions as Record<string, unknown>[])[0]!.value).toBe("0xff");
  });

  it("passes idempotencyKey as taskId and dedupes a retried submit (no second send)", async () => {
    const send = vi.fn(() => "task_dedupe");
    const { impl, calls } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: send,
      relayer_getStatus: () => statusAt(RELAY_STATUS.QUEUED),
    });
    const r = relayer(impl);
    const b = moveBundle({ idempotencyKey: "pot:7:refund:0xabc:1" });
    const h1 = await r.submitBundle(b);
    const h2 = await r.submitBundle(b);
    expect(h1).toEqual(h2);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = calls.find((c) => c.method === "relayer_send7710Transaction")!;
    expect((sent.params as [Record<string, unknown>])[0].taskId).toBe("pot:7:refund:0xabc:1");
  });

  it("sets destinationUrl and then does NOT poll", async () => {
    const status = vi.fn(() => statusAt(RELAY_STATUS.QUEUED));
    const { impl, calls } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "t",
      relayer_getStatus: status,
    });
    await relayer(impl, { destinationUrl: "https://app.test/hook" }).submitBundle(moveBundle());
    const sent = calls.find((c) => c.method === "relayer_send7710Transaction")!;
    expect((sent.params as [Record<string, unknown>])[0].destinationUrl).toBe("https://app.test/hook");
    expect(status).not.toHaveBeenCalled();
  });

  it("HARD-REJECTS when the delegate != relayer targetAddress (TARGET_MISMATCH)", async () => {
    const { impl } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "t",
    });
    await expect(
      relayer(impl).submitBundle(moveBundle({ permissionContext: [delegation(OTHER)] })),
    ).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  });

  it("HARD-REJECTS a money bundle with no permissionContext when requireTarget is set", async () => {
    const { impl } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "t",
    });
    await expect(
      relayer(impl).submitBundle({
        encodedTxns: [{ to: USDC, data: "0x" }],
        requireTarget: true,
      }),
    ).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  });

  it("rejects an empty bundle", async () => {
    const { impl } = rpcFetch({ relayer_getCapabilities: () => capsResult() });
    await expect(relayer(impl).submitBundle({ encodedTxns: [] })).rejects.toMatchObject({
      code: "RELAYER_FAILED",
    });
  });

  it("forwards an inline EIP-7702 authorizationList", async () => {
    const { impl, calls } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "t",
      relayer_getStatus: () => statusAt(RELAY_STATUS.QUEUED),
    });
    await relayer(impl).submitBundle(
      moveBundle({
        authorizationList: [
          { address: PLAYER, chainId: 84532, nonce: 0, r: "0x1", s: "0x2", yParity: 0 },
        ],
      }),
    );
    const sent = calls.find((c) => c.method === "relayer_send7710Transaction")!;
    expect((sent.params as [Record<string, unknown>])[0].authorizationList).toHaveLength(1);
  });
});

describe("OneShotPublicRelayer status mapping + polling", () => {
  it("emits a terminal mined event with txHash + blockNumber once SUCCESS is seen", async () => {
    let n = 0;
    const { impl } = rpcFetch({
      relayer_getCapabilities: () => capsResult(),
      relayer_send7710Transaction: () => "task_mine",
      relayer_getStatus: () => (++n < 2 ? statusAt(RELAY_STATUS.QUEUED) : minedStatus()),
    });
    const r = relayer(impl);
    const events: StatusEvent[] = [];
    r.onStatus((e) => events.push(e));
    await r.submitBundle(moveBundle());

    await vi.waitFor(() => expect(events.some((e) => e.status === "mined")).toBe(true));
    const mined = events.find((e) => e.status === "mined")!;
    expect(mined.txHash).toBe("0xfeed");
    expect(mined.blockNumber).toBe(7n);
  });

  it("maps a 400/500 status to a failed event with the revert message", () => {
    const failed = mapStatus("id", {
      id: "id",
      chainId: "84532",
      createdAt: 0,
      status: RELAY_STATUS.CLIENT_ERROR,
      message: "execution reverted: not your turn",
    } as RelayStatusResult);
    expect(failed.status).toBe("failed");
    expect(failed.revert).toContain("not your turn");
  });

  it("maps SUBMITTED (110) to a pending event carrying the broadcast hash", () => {
    const ev = mapStatus("id", {
      id: "id",
      chainId: "84532",
      createdAt: 0,
      status: RELAY_STATUS.SUBMITTED,
      hash: "0xbroadcast",
    } as RelayStatusResult);
    expect(ev.status).toBe("pending");
    expect(ev.txHash).toBe("0xbroadcast");
  });

  it("ingestStatus emits once and dedupes terminal redeliveries", () => {
    const { impl } = rpcFetch({});
    const r = relayer(impl);
    const events: StatusEvent[] = [];
    r.onStatus((e) => events.push(e));
    const payload = minedStatus("task_x") as RelayStatusResult;
    expect(r.ingestStatus(payload)?.status).toBe("mined");
    expect(r.ingestStatus(payload)).toBeNull(); // redelivery dropped
    expect(events).toHaveLength(1);
  });
});

describe("OneShotPublicRelayer.upgradeEOA", () => {
  it("steers callers to the inline authorizationList path", async () => {
    const { impl } = rpcFetch({});
    await expect(
      relayer(impl).upgradeEOA({ account: PLAYER, implementation: OTHER, signedAuth: "0x" }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});

describe("OneShotPublicRelayer config", () => {
  it("requires a chainId", () => {
    expect(() => new OneShotPublicRelayer({ chainId: "", fetchImpl: (async () => jsonRes({})) as FetchImpl }))
      .toThrow(NexusError);
  });
});

// ── helpers ──
function statusAt(status: number, id = "task"): RelayStatusResult {
  return { id, chainId: "84532", createdAt: 0, status } as RelayStatusResult;
}
function minedStatus(id = "task_mine"): RelayStatusResult {
  return {
    id,
    chainId: "84532",
    createdAt: 0,
    status: RELAY_STATUS.SUCCESS,
    receipt: {
      blockHash: "0x0",
      blockNumber: "7",
      gasUsed: "0x0",
      transactionHash: "0xfeed",
    },
  } as RelayStatusResult;
}
