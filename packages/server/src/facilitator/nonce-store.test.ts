import { type Hex, asAddress } from "@nexus/types";
import { describe, expect, it } from "vitest";
import { InMemoryNonceStore, randomNonce } from "./nonce-store.js";

const PAYER = asAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = asAddress("0x2222222222222222222222222222222222222222");

function issue(store: InMemoryNonceStore, expiresAt: number) {
  return store.issue({ payer: PAYER, price: "5000000", recipient: RECIPIENT, expiresAt });
}

describe("randomNonce", () => {
  it("returns a unique 32-byte hex each call", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("InMemoryNonceStore", () => {
  it("issues then consumes a nonce exactly once", () => {
    const store = new InMemoryNonceStore();
    const rec = issue(store, Date.now() + 60_000);
    const consumed = store.consume(rec.nonce);
    expect(consumed.nonce).toBe(rec.nonce);
    expect(consumed.used).toBe(true);
  });

  it("rejects a replayed nonce with NONCE_REUSED (REPLAY)", () => {
    const store = new InMemoryNonceStore();
    const rec = issue(store, Date.now() + 60_000);
    store.consume(rec.nonce);
    expect(() => store.consume(rec.nonce)).toThrowError(/already redeemed/);
  });

  it("rejects an unknown nonce", () => {
    const store = new InMemoryNonceStore();
    expect(() => store.consume(randomNonce())).toThrowError(/unknown 402 nonce/);
  });

  it("rejects an expired challenge (CHALLENGE_EXPIRED)", () => {
    const store = new InMemoryNonceStore();
    const rec = issue(store, Date.now() - 1);
    expect(() => store.consume(rec.nonce)).toThrowError(/expired/);
  });

  it("only one of concurrent consumes wins (single-use CAS)", () => {
    const store = new InMemoryNonceStore();
    const rec = issue(store, Date.now() + 60_000);
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        store.consume(rec.nonce);
        results.push("ok");
      } catch {
        results.push("rejected");
      }
    }
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "rejected")).toHaveLength(4);
  });

  it("get() returns the record or undefined", () => {
    const store = new InMemoryNonceStore();
    const rec = issue(store, Date.now() + 60_000);
    expect(store.get(rec.nonce)?.payer).toBe(PAYER);
    expect(store.get(randomNonce() as Hex)).toBeUndefined();
  });
});
