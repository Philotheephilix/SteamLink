import { CHAINS, asAddress } from "@nexus/types";
import { describe, expect, it, vi } from "vitest";
import { DirectRelayer } from "./direct.js";

/**
 * Unit coverage for the transport-level invariants that don't require a chain.
 * The full LIVE path (real broadcasts + receipts) is exercised by the scripts/
 * live test suite against Base Sepolia — not here.
 */
function fakeClients(addr: string) {
  const wallet = {
    account: { address: addr },
    sendTransaction: vi.fn(),
  } as never;
  const publicClient = {
    chain: { name: "Base Sepolia" },
    waitForTransactionReceipt: vi.fn(),
  } as never;
  return { wallet, publicClient };
}

describe("DirectRelayer.getCapabilities", () => {
  it("reports the configured USDC and self as target (self-relay)", async () => {
    const me = "0x1111111111111111111111111111111111111111";
    const { wallet, publicClient } = fakeClients(me);
    const r = new DirectRelayer({
      wallet,
      publicClient,
      usdc: asAddress(CHAINS["base-sepolia"].usdc),
    });
    const caps = await r.getCapabilities();
    expect(caps.tokens.USDC).toBe(CHAINS["base-sepolia"].usdc.toLowerCase());
    expect(caps.targetAddress).toBe(asAddress(me));
    expect(caps.chains).toEqual(["Base Sepolia"]);
  });
});

describe("DirectRelayer.submitBundle", () => {
  it("rejects an empty bundle", async () => {
    const { wallet, publicClient } = fakeClients("0x2222222222222222222222222222222222222222");
    const r = new DirectRelayer({
      wallet,
      publicClient,
      usdc: asAddress(CHAINS["base-sepolia"].usdc),
    });
    await expect(r.submitBundle({ encodedTxns: [] })).rejects.toThrow(/no transactions/);
  });
});
