import { NexusError } from "@nexus/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toMessage, useCharge, useNexus, useSession } from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";
import { ADDRESSES, makeConfig, wrapper } from "./fixtures.js";

const PERMS = {
  gameplay: { allowedSystems: [], expiresAt: Date.now() + 3_600_000 },
  budget: {
    token: "USDC" as const,
    totalCap: "5",
    perActionCap: "5",
    allowedRecipients: [ADDRESSES.usdc],
  },
};

function harness(transport: FakeTransport) {
  return renderHook(
    () => {
      const session = useSession();
      const charge = useCharge();
      const nexus = useNexus();
      return { session, charge, nexus };
    },
    { wrapper: wrapper(makeConfig(transport)) },
  );
}

describe("useCharge", () => {
  it("optimistically decrements remaining, then rolls back + surfaces BUDGET_EXCEEDED", async () => {
    const transport = new FakeTransport();
    const { result } = harness(transport);

    await act(async () => {
      await result.current.session.join(1n, PERMS);
    });
    await waitFor(() => expect(result.current.charge.remaining).toBe("5"));

    let settled: unknown;
    await act(async () => {
      result.current.charge.charge({ amount: "2", to: ADDRESSES.usdc }).then(
        (v) => {
          settled = v;
        },
        (e) => {
          settled = e;
        },
      );
    });

    // Optimistic decrement applied: 5 - 2 = 3.
    await waitFor(() => expect(result.current.charge.remaining).toBe("3"));

    const bundleId = transport.submitted[0]!.bundleId;
    act(() => {
      result.current.nexus.manager.applyStatus({
        bundleId,
        status: "failed",
        code: "BUDGET_EXCEEDED",
        reason: "over cap",
      });
    });

    await waitFor(() => expect(settled).toBeInstanceOf(NexusError));
    expect((settled as NexusError).code).toBe("BUDGET_EXCEEDED");
    expect(toMessage(settled as NexusError)).toBe("Out of budget");
    // Rolled back to full budget.
    await waitFor(() => expect(result.current.charge.remaining).toBe("5"));
  });
});
