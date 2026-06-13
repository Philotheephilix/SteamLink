import { NexusError } from "@nexus/types";
import { describe, expect, it, vi } from "vitest";
import { OneShotRelayer, signWebhook } from "./oneshot.js";
import type { FetchImpl } from "./oneshot.js";
import type { Bundle, StatusEvent } from "./port.js";

const TARGET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FEE = "0xcccccccccccccccccccccccccccccccccccccccc";

function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CAPS_BODY = {
  chains: ["base-sepolia"],
  tokens: { USDC },
  feeCollector: FEE,
  targetAddress: TARGET,
};

/** A fake fetch routing by URL/method to canned 1Shot responses. */
function fakeFetch(routes: Record<string, () => ReturnType<FetchImpl>>): {
  impl: FetchImpl;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const impl: FetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const key = `${method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`no route for ${key}`);
    return handler();
  };
  return { impl, calls };
}

function relayer(impl: FetchImpl, webhookUrl?: string) {
  return new OneShotRelayer({
    apiKey: "k",
    apiSecret: "s",
    endpoint: "https://api.1shot.test/v1",
    webhookUrl,
    fetchImpl: impl,
  });
}

describe("OneShotRelayer.getCapabilities", () => {
  it("parses tokens/feeCollector/targetAddress and caches (no re-fetch)", async () => {
    const fetchSpy = vi.fn(async () => jsonRes(CAPS_BODY));
    const { impl, calls } = fakeFetch({
      "GET /v1/relayer/capabilities": fetchSpy as never,
    });
    const r = relayer(impl);

    const caps = await r.getCapabilities();
    expect(caps.tokens.USDC).toBe(USDC);
    expect(caps.feeCollector).toBe(FEE);
    expect(caps.targetAddress).toBe(TARGET);
    expect(caps.chains).toEqual(["base-sepolia"]);

    await r.getCapabilities();
    // Second call served from cache — fetch hit exactly once.
    expect(calls.filter((c) => c.url.endsWith("/capabilities"))).toHaveLength(1);
  });

  it("throws CAPABILITIES_UNAVAILABLE when the fetch fails", async () => {
    const impl: FetchImpl = async () => {
      throw new Error("network down");
    };
    const r = relayer(impl);
    await expect(r.getCapabilities()).rejects.toMatchObject({ code: "CAPABILITIES_UNAVAILABLE" });
  });

  it("throws CAPABILITIES_UNAVAILABLE on a non-2xx response", async () => {
    const { impl } = fakeFetch({
      "GET /v1/relayer/capabilities": () => jsonRes({}, false, 503) as never,
    });
    await expect(relayer(impl).getCapabilities()).rejects.toMatchObject({
      code: "CAPABILITIES_UNAVAILABLE",
    });
  });
});

describe("OneShotRelayer.submitBundle", () => {
  const goodBundle: Bundle = {
    delegationContext: { to: TARGET } as never,
    encodedTxns: [{ to: USDC as never, data: "0x" as never }],
    destinationUrl: "https://app.test/nexus/webhook",
  };

  it("rejects TARGET_MISMATCH before any POST", async () => {
    let posted = false;
    const { impl } = fakeFetch({
      "GET /v1/relayer/capabilities": () => jsonRes(CAPS_BODY) as never,
      "POST /v1/relayer/bundles": () => {
        posted = true;
        return jsonRes({ bundleId: "x" }) as never;
      },
    });
    const r = relayer(impl);
    const bad: Bundle = {
      delegationContext: { to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } as never,
      encodedTxns: [{ to: USDC as never, data: "0x" as never }],
    };
    await expect(r.submitBundle(bad)).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    expect(posted).toBe(false);
  });

  it("posts and returns the bundleId on a matching target", async () => {
    const { impl, calls } = fakeFetch({
      "GET /v1/relayer/capabilities": () => jsonRes(CAPS_BODY) as never,
      "POST /v1/relayer/bundles": () =>
        jsonRes({ bundleId: "1shot_abc", txHash: "0xfeed" }) as never,
    });
    const r = relayer(impl, "https://app.test/nexus/webhook");
    const handle = await r.submitBundle(goodBundle);
    expect(handle.bundleId).toBe("1shot_abc");
    expect(handle.txHash).toBe("0xfeed");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/bundles"))).toBe(true);
  });

  it("rejects an empty bundle without fetching", async () => {
    const impl: FetchImpl = async () => {
      throw new Error("should not be called");
    };
    await expect(relayer(impl).submitBundle({ encodedTxns: [] })).rejects.toThrow(
      /no transactions/,
    );
  });
});

describe("OneShotRelayer.ingestWebhook", () => {
  it("emits a StatusEvent to subscribers and dedupes by bundleId", async () => {
    const { impl } = fakeFetch({});
    const r = relayer(impl, "https://app.test/nexus/webhook");
    const events: StatusEvent[] = [];
    r.onStatus((e) => events.push(e));

    const headers = { "x-1shot-signature": signWebhook("s", "1shot_abc") };
    const payload = {
      bundleId: "1shot_abc",
      status: "mined" as const,
      txHash: "0xfeed" as never,
      blockNumber: "0x10",
    };
    r.ingestWebhook(payload, headers);
    // Redelivery of the same terminal bundle is dropped.
    const dup = r.ingestWebhook(payload, headers);

    expect(dup).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ bundleId: "1shot_abc", status: "mined", txHash: "0xfeed" });
    expect(events[0]?.blockNumber).toBe(16n);
  });

  it("throws WEBHOOK_UNVERIFIED on a bad signature, emitting nothing", async () => {
    const { impl } = fakeFetch({});
    const r = relayer(impl, "https://app.test/nexus/webhook");
    const events: StatusEvent[] = [];
    r.onStatus((e) => events.push(e));
    expect(() =>
      r.ingestWebhook({ bundleId: "b", status: "mined" }, { "x-1shot-signature": "0xdeadbeef" }),
    ).toThrow(NexusError);
    expect(events).toHaveLength(0);
  });
});

describe("OneShotRelayer.upgradeEOA", () => {
  it("posts the 7702 auth and returns the unchanged account", async () => {
    const account = "0x1111111111111111111111111111111111111111";
    const { impl } = fakeFetch({
      "POST /v1/relayer/upgrade": () => jsonRes({ txHash: "0xup" }) as never,
    });
    const res = await relayer(impl).upgradeEOA({
      account: account as never,
      implementation: TARGET as never,
      signedAuth: "0x" as never,
    });
    expect(res.account).toBe(account);
    expect(res.txHash).toBe("0xup");
  });
});
