import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTurn } from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";
import { SIGNER, makeConfig, wrapper } from "./fixtures.js";

describe("useTurn", () => {
  it("reflects the current player and derives isMyTurn", async () => {
    const transport = new FakeTransport();
    transport.setTurn(1n, {
      current: SIGNER.address.toLowerCase() as `0x${string}`,
      deadline: Date.now() + 30_000,
      direction: 1,
    });
    const config = makeConfig(transport);
    // useTurn compares against session.account; account falls back to signer.
    config.signer = SIGNER;

    const { result } = renderHook(() => useTurn(1n), { wrapper: wrapper(config) });

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.current?.toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(result.current.direction).toBe(1);
    expect(typeof result.current.secondsLeft).toBe("number");
  });

  it("reports not-my-turn for a different player", async () => {
    const transport = new FakeTransport();
    transport.setTurn(2n, {
      current: "0x000000000000000000000000000000000000dead",
      deadline: null,
      direction: null,
    });
    const config = makeConfig(transport);

    const { result } = renderHook(() => useTurn(2n), { wrapper: wrapper(config) });

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.isMyTurn).toBe(false);
  });
});
