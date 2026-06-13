import { MANAGER_ABI } from "@nexus/core";
import { NexusError } from "@nexus/types";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { type Backend, createBackend, createGatewayApp } from "../src/index.js";
import {
  FakeRelayer,
  SIGNER_ADDRESS,
  TARGET,
  authHeaders,
  lastBundle,
  saneDelegationFor,
  uno,
} from "./fixtures.js";

async function boot(): Promise<{ backend: Backend; relayer: FakeRelayer }> {
  const relayer = new FakeRelayer();
  const backend = createBackend({
    chain: "base",
    world: TARGET,
    relayer,
    games: [uno],
    // Dev stub facilitator is fine here: the charge route only ISSUES the 402
    // challenge; settlement verification happens on the webhook path (tested
    // separately). C6 still forbids the stub from fabricating a settlement.
    allowUnsafeDevFacilitator: true,
  });
  await backend.start();
  return { backend, relayer };
}

/** Join two players so the room is active; the FIRST player is the test signer. */
async function activeRoom(backend: Backend): Promise<{ roomId: string; sessionId: string }> {
  const roomId = await backend.rooms.createRoom("uno", { quorum: 2 });
  const s = await backend.rooms.joinRoom(roomId, saneDelegationFor(SIGNER_ADDRESS));
  const p2 = saneDelegationFor("0x3333333333333333333333333333333333333333");
  await backend.rooms.joinRoom(roomId, p2);
  return { roomId, sessionId: s.sessionId };
}

describe("gateway routes (Hono test client)", () => {
  it("GET /healthz works", async () => {
    const { backend } = await boot();
    const app = createGatewayApp(backend);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /readyz is green once capabilities + indexer resolve", async () => {
    const { backend } = await boot();
    const app = createGatewayApp(backend);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true });
  });

  it("unknown game → GAME_NOT_FOUND (after auth passes)", async () => {
    const { backend } = await boot();
    const app = createGatewayApp(backend);
    const path = "/game/nope/state/TurnOrder";
    const headers = await authHeaders("GET", path, {});
    const res = await app.request(path, { headers });
    expect(res.status).toBe(500); // INVALID_CONFIG → 500; body carries the code
    expect(JSON.stringify(await res.json())).toContain("GAME_NOT_FOUND");
  });

  it("rejects a session-scoped request with NO signature (C5)", async () => {
    const { backend } = await boot();
    const { sessionId } = await activeRoom(backend);
    const app = createGatewayApp(backend);
    const res = await app.request("/game/uno/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, encodedExecution: `0x${"de".repeat(36)}` }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a FORGED caller: signer != session player (C5)", async () => {
    const { backend, relayer } = await boot();
    const { sessionId } = await activeRoom(backend);
    const app = createGatewayApp(backend);
    // A DIFFERENT signer (not the session owner) signs the move.
    const attacker = (await import("viem/accounts")).privateKeyToAccount(
      `0x${"22".repeat(32)}` as `0x${string}`,
    );
    const body = { sessionId, encodedExecution: `0x${"de".repeat(36)}` };
    const headers = {
      "content-type": "application/json",
      ...(await authHeaders("POST", "/game/uno/move", body, attacker)),
    };
    const res = await app.request("/game/uno/move", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // Auth passes (the attacker's own signature is valid) but the move lifecycle
    // rejects: the recovered signer is not the session owner.
    expect(res.status).not.toBe(202);
    expect(relayer.bundles).toHaveLength(0);
  });

  it("routes a correctly-SIGNED /move to the relayer and returns 202 { callId }", async () => {
    const { backend, relayer } = await boot();
    const { sessionId } = await activeRoom(backend);
    const app = createGatewayApp(backend);
    const body = { sessionId, encodedExecution: `0x${"de".repeat(36)}` };
    const headers = {
      "content-type": "application/json",
      ...(await authHeaders("POST", "/game/uno/move", body)),
    };
    const res = await app.request("/game/uno/move", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const out = (await res.json()) as { callId: string };
    expect(out.callId).toMatch(/^fake-/);
    expect(relayer.bundles).toHaveLength(1);
    const bundle = lastBundle(relayer);
    expect(bundle.delegationContext).toBeTruthy();
    // The bundle MUST be a real on-chain redemption: a `redeemDelegations` call
    // addressed to the delegation manager (delegation.to == relayer targetAddress),
    // NOT the raw execution broadcast straight to the manager.
    const call = bundle.encodedTxns[0]!;
    expect(call.to).toBe(TARGET);
    const decoded = decodeFunctionData({ abi: MANAGER_ABI, data: call.data });
    expect(decoded.functionName).toBe("redeemDelegations");
    // redeemDelegations(permissionContexts[], modes[], executionCalldatas[])
    expect((decoded.args[0] as readonly unknown[]).length).toBe(1);
    expect((decoded.args[2] as readonly unknown[]).length).toBe(1);
  });

  it("returns 402 challenge body when a SIGNED /charge is issued without prior payment", async () => {
    const { backend, relayer } = await boot();
    const { sessionId } = await activeRoom(backend);
    const app = createGatewayApp(backend);
    const body = { sessionId, amount: "5", to: TARGET };
    const headers = {
      "content-type": "application/json",
      ...(await authHeaders("POST", "/game/uno/charge", body)),
    };
    const res = await app.request("/game/uno/charge", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const out = (await res.json()) as {
      callId: string;
      challenge: { scheme: string; price: string; nonce: string };
    };
    expect(out.challenge.scheme).toBe("x402");
    expect(out.challenge.price).toBe("5");
    expect(out.challenge.nonce).toBeTruthy();
    expect(relayer.bundles).toHaveLength(1);
    // The charge bundle MUST be a real `redeemDelegations` call to the manager
    // (delegation.to), wrapping the budget transferFrom execution — not a raw
    // ERC-20 transfer broadcast to the token.
    const bundle = lastBundle(relayer);
    const call = bundle.encodedTxns[0]!;
    expect(call.to).toBe(TARGET);
    expect(bundle.requireTarget).toBe(true);
    const decoded = decodeFunctionData({ abi: MANAGER_ABI, data: call.data });
    expect(decoded.functionName).toBe("redeemDelegations");
  });

  it("rejects an unsigned /charge (C5)", async () => {
    const { backend, relayer } = await boot();
    const { sessionId } = await activeRoom(backend);
    const app = createGatewayApp(backend);
    const res = await app.request("/game/uno/charge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, amount: "5", to: TARGET }),
    });
    expect(res.status).toBe(401);
    expect(relayer.bundles).toHaveLength(0);
  });
});

describe("StubFacilitator no longer fabricates settlements (C6)", () => {
  it("StubFacilitator.verify rejects a redemption with no on-chain confirmation", async () => {
    const { backend } = await boot();
    await expect(
      backend.facilitator.verify({
        nonce: `0x${"00".repeat(32)}`,
        payer: SIGNER_ADDRESS,
        delegationContext: "0x",
      }),
    ).rejects.toThrow(NexusError);
  });
});
