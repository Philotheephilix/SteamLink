import { MANAGER_ABI } from "@nexus/core";
import { NexusError } from "@nexus/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { useGameActions, useNexus, useSession, useTable } from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";
import { ADDRESSES, makeConfig, wrapper } from "./fixtures.js";

const SYSTEM_ID = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

const PERMS = {
  gameplay: {
    allowedSystems: [SYSTEM_ID],
    turnBound: true,
    expiresAt: Date.now() + 3_600_000,
  },
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
      const actions = useGameActions();
      const hand = useTable("Hand", { player: "0xme" });
      const nexus = useNexus();
      return { session, actions, hand, nexus };
    },
    { wrapper: wrapper(makeConfig(transport)) },
  );
}

describe("useGameActions.move", () => {
  it("produces a well-formed redemption (decodes to redeemDelegations)", async () => {
    const transport = new FakeTransport();
    const { result } = harness(transport);

    await act(async () => {
      await result.current.session.join(1n, PERMS);
    });

    let movePromise!: Promise<{ calldata: string }>;
    act(() => {
      movePromise = result.current.actions.move("PlayCardSystem", SYSTEM_ID);
    });

    await waitFor(() => expect(transport.submitted.length).toBe(1));
    const { calldata, bundleId } = transport.submitted[0]!;
    const decoded = decodeFunctionData({ abi: MANAGER_ABI, data: calldata as `0x${string}` });
    expect(decoded.functionName).toBe("redeemDelegations");
    expect(decoded.args[0]).toHaveLength(1); // permissionContexts
    expect(decoded.args[1]).toHaveLength(1); // modes
    expect(decoded.args[2]).toHaveLength(1); // executionCallDatas
    expect(bundleId).toMatch(/^bundle-/);

    // Mine it so the promise resolves cleanly (no dangling rejection).
    act(() => {
      result.current.nexus.manager.applyStatus({ bundleId, status: "mined", txHash: "0xdead" });
    });
    const res = await movePromise;
    expect(res.calldata).toBe(calldata);
    await waitFor(() => expect(result.current.actions.isPending).toBe(false));
  });

  it("applies an optimistic overlay then rolls back on rejection", async () => {
    const transport = new FakeTransport();
    transport.seed("Hand", [
      { player: "0xme", commitment: "c1", cardId: 1 },
      { player: "0xme", commitment: "c2", cardId: 2 },
    ]);
    const { result } = harness(transport);

    await act(async () => {
      await result.current.session.join(1n, PERMS);
    });
    await waitFor(() => expect(result.current.hand.status).toBe("live"));
    expect(result.current.hand.data).toHaveLength(2);

    let settled: unknown;
    act(() => {
      result.current.actions
        .move("PlayCardSystem", SYSTEM_ID, {
          optimistic: {
            table: "Hand",
            where: { player: "0xme" },
            mutate: (rows) => rows.filter((r) => r.commitment !== "c1"),
          },
        })
        .then(
          (v) => {
            settled = v;
          },
          (e) => {
            settled = e;
          },
        );
    });

    // Optimistic apply: c1 is gone immediately, before any webhook.
    await waitFor(() => expect(result.current.hand.data).toHaveLength(1));
    expect(result.current.hand.data[0]?.commitment).toBe("c2");
    expect(result.current.hand.isOptimistic).toBe(true);

    const bundleId = transport.submitted[0]!.bundleId;

    // Webhook rejects with NOT_YOUR_TURN -> rollback + typed error.
    act(() => {
      result.current.nexus.manager.applyStatus({
        bundleId,
        status: "failed",
        code: "NOT_YOUR_TURN",
        reason: "not your turn",
      });
    });

    await waitFor(() => expect(result.current.hand.data).toHaveLength(2));
    expect(result.current.hand.isOptimistic).toBe(false);
    await waitFor(() => expect(settled).toBeInstanceOf(NexusError));
    expect((settled as NexusError).code).toBe("NOT_YOUR_TURN");
  });

  it("rolls back the overlay and rejects (no hang) when transport has no submit (H6)", async () => {
    const transport = new FakeTransport();
    transport.seed("Hand", [
      { player: "0xme", commitment: "c1", cardId: 1 },
      { player: "0xme", commitment: "c2", cardId: 2 },
    ]);
    // A transport with no submit() — e.g. read-only/client-only — must not leave
    // the optimistic overlay stuck or the move promise unsettled forever.
    (transport as { submit?: unknown }).submit = undefined;
    const { result } = harness(transport);

    await act(async () => {
      await result.current.session.join(1n, PERMS);
    });
    await waitFor(() => expect(result.current.hand.status).toBe("live"));
    expect(result.current.hand.data).toHaveLength(2);

    let settled: unknown;
    act(() => {
      result.current.actions
        .move("PlayCardSystem", SYSTEM_ID, {
          optimistic: {
            table: "Hand",
            where: { player: "0xme" },
            mutate: (rows) => rows.filter((r) => r.commitment !== "c1"),
          },
        })
        .then(
          (v) => {
            settled = v;
          },
          (e) => {
            settled = e;
          },
        );
    });

    // The promise must reject with a typed error (not hang), and the overlay
    // must roll back so the row reappears.
    await waitFor(() => expect(settled).toBeInstanceOf(NexusError));
    expect((settled as NexusError).code).toBe("RELAYER_FAILED");
    await waitFor(() => expect(result.current.hand.data).toHaveLength(2));
    expect(result.current.hand.isOptimistic).toBe(false);
    await waitFor(() => expect(result.current.actions.isPending).toBe(false));
  });

  it("auto-fails and rolls back when no terminal status arrives within timeoutMs (H6)", async () => {
    const transport = new FakeTransport();
    transport.seed("Hand", [
      { player: "0xme", commitment: "c1", cardId: 1 },
      { player: "0xme", commitment: "c2", cardId: 2 },
    ]);
    const { result } = harness(transport);

    await act(async () => {
      await result.current.session.join(1n, PERMS);
    });
    await waitFor(() => expect(result.current.hand.status).toBe("live"));

    let settled: unknown;
    act(() => {
      result.current.actions
        .move("PlayCardSystem", SYSTEM_ID, {
          timeoutMs: 20,
          optimistic: {
            table: "Hand",
            where: { player: "0xme" },
            mutate: (rows) => rows.filter((r) => r.commitment !== "c1"),
          },
        })
        .then(
          (v) => {
            settled = v;
          },
          (e) => {
            settled = e;
          },
        );
    });

    // Submit happened but no relayer status ever arrives -> timeout rolls back.
    await waitFor(() => expect(transport.submitted.length).toBe(1));
    await waitFor(() => expect(settled).toBeInstanceOf(NexusError), { timeout: 1000 });
    expect((settled as NexusError).code).toBe("RELAYER_FAILED");
    await waitFor(() => expect(result.current.hand.data).toHaveLength(2));
  });
});
