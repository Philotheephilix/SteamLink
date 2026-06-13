import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTable } from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";
import { makeConfig, wrapper } from "./fixtures.js";

describe("useTable", () => {
  it("returns seeded rows and updates on a simulated subscribe event", async () => {
    const transport = new FakeTransport();
    transport.seed("Hand", [
      { player: "0xabc", cardId: 1 },
      { player: "0xdef", cardId: 2 },
    ]);
    const config = makeConfig(transport);

    const { result } = renderHook(() => useTable("Hand", { player: "0xabc" }), {
      wrapper: wrapper(config),
    });

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.data).toEqual([{ player: "0xabc", cardId: 1 }]);
    expect(result.current.loading).toBe(false);

    // Simulate an indexer/WS push.
    act(() => {
      transport.push("Hand", [
        { player: "0xabc", cardId: 1 },
        { player: "0xabc", cardId: 7 },
      ]);
    });

    expect(result.current.data).toEqual([
      { player: "0xabc", cardId: 1 },
      { player: "0xabc", cardId: 7 },
    ]);
  });

  it("dedupes subscriptions by stable where key across consumers", async () => {
    const transport = new FakeTransport();
    transport.seed("TurnOrder", [{ roomId: 1n, idx: 0 }]);
    const config = makeConfig(transport);

    const { result } = renderHook(
      () => {
        const a = useTable("TurnOrder", { roomId: 1n });
        const b = useTable("TurnOrder", { roomId: 1n });
        return { a, b };
      },
      { wrapper: wrapper(config) },
    );

    await waitFor(() => expect(result.current.a.status).toBe("live"));
    // Both consumers, one transport subscription for the shared key.
    expect(transport.subscribeCalls.length).toBe(1);
  });
});
