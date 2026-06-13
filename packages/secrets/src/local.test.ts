import { NexusError } from "@nexus/types";
import { verifyMessage } from "viem";
import { describe, expect, it } from "vitest";
import { attestationDigest, decodeAttestationPayload } from "./attestation.js";
import { defaultPolicyRegistry } from "./conditions/registry.js";
import { LocalSecrets } from "./local.js";
import { encodeHand } from "./moveRule.js";
import type { AccessCondition, AuthContext, MoveClaim } from "./types.js";

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const ownerCondition: AccessCondition[] = [
  {
    chain: "base",
    method: "ownerOf",
    standardContractType: "ERC721",
    returns: { comparator: "=", value: ":userAddress" },
  },
];

describe("LocalSecrets seal/reveal", () => {
  it("roundtrips the exact bytes through seal then reveal", async () => {
    const secrets = new LocalSecrets();
    const data = new TextEncoder().encode("hidden hand: [red-5, blue-2, wild]");
    const sealed = await secrets.seal(data, ownerCondition);

    expect(sealed.alg).toBe("AES-256-GCM");
    expect(sealed.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    // ciphertext must not contain the plaintext
    expect(Buffer.from(sealed.ciphertext, "base64").toString()).not.toContain("hidden hand");

    const auth: AuthContext = { caller: ALICE, state: { ownerOf: ALICE } };
    const out = await secrets.reveal(sealed, auth);
    expect(new TextDecoder().decode(out)).toBe("hidden hand: [red-5, blue-2, wild]");
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it("denies reveal when the condition predicate returns false", async () => {
    // Predicate that always denies.
    const secrets = new LocalSecrets({ predicate: () => false });
    const sealed = await secrets.seal(new Uint8Array([1, 2, 3]), ownerCondition);
    await expect(secrets.reveal(sealed, { caller: ALICE })).rejects.toMatchObject({
      code: "REVEAL_DENIED",
    });
  });

  it("denies reveal when a different caller asks (default predicate)", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(new Uint8Array([9]), ownerCondition);
    // owner is ALICE; BOB requests
    await expect(
      secrets.reveal(sealed, { caller: BOB, state: { ownerOf: ALICE } }),
    ).rejects.toBeInstanceOf(NexusError);
  });
});

describe("named policy templates", () => {
  it("only-owner expands to an ownerOf == :userAddress condition", () => {
    const c = defaultPolicyRegistry.expand("only-owner", {
      world: "0x1111111111111111111111111111111111111111",
      handId: "0xabc",
    });
    expect(c).toEqual([
      {
        chain: "base",
        method: "ownerOf",
        standardContractType: "ERC721",
        contractAddress: "0x1111111111111111111111111111111111111111",
        parameters: ["0xabc"],
        returns: { comparator: "=", value: ":userAddress" },
      },
    ]);
  });

  it("reveal-after-round-end expands to an isRoundEnded == true condition", () => {
    const c = defaultPolicyRegistry.expand("reveal-after-round-end", {
      world: "0x2222222222222222222222222222222222222222",
      roomId: "room-1",
      roundId: "3",
    });
    expect(c[0]?.method).toBe("isRoundEnded");
    expect(c[0]?.parameters).toEqual(["room-1", "3"]);
    expect(c[0]?.returns).toEqual({ comparator: "=", value: "true" });
  });

  it("decrypt-after-payment-confirmed expands to an isSettled == true condition", () => {
    const c = defaultPolicyRegistry.expand("decrypt-after-payment-confirmed", {
      escrow: "0x3333333333333333333333333333333333333333",
      invoiceId: "inv-7",
    });
    expect(c[0]?.method).toBe("isSettled");
    expect(c[0]?.parameters).toEqual(["inv-7"]);
  });

  it("rejects an unknown policy name", () => {
    expect(() => defaultPolicyRegistry.expand("nope")).toThrow(NexusError);
  });

  it("registers a valid custom policy and rejects undeclared-variable templates", () => {
    const reg = defaultPolicyRegistry;
    reg.registerPolicy("sealed-bid-until-deadline", (ctx) => [
      {
        chain: "base",
        method: "blockTimestampGte",
        parameters: [ctx.deadline ?? ":deadline"],
        returns: { comparator: "=", value: "true" },
      },
    ]);
    expect(reg.listPolicies()).toContain("sealed-bid-until-deadline");

    // references a non-existent context key -> rejected
    expect(() =>
      reg.registerPolicy("bad", (ctx: Record<string, unknown>) => [
        {
          chain: "base",
          method: "x",
          parameters: [String(ctx.notAThing)],
          returns: { comparator: "=", value: "true" },
        },
      ]),
    ).toThrow(NexusError);
  });

  it("rejects a non-Base condition at registration", () => {
    expect(() =>
      defaultPolicyRegistry.registerPolicy("evil", () => [
        // @ts-expect-error deliberately invalid chain
        { chain: "ethereum", method: "x", returns: { comparator: "=", value: "1" } },
      ]),
    ).toThrow(NexusError);
  });
});

describe("LocalSecrets verify (legal move without reveal)", () => {
  // hand: card id 10 = red(0) 5; id 11 = blue(1) 2; id 12 = wild
  const hand = encodeHand([
    { id: 10, color: 0, number: 5, isWild: false },
    { id: 11, color: 1, number: 2, isWild: false },
    { id: 12, color: 9, number: 0, isWild: true },
  ]);
  // discard top: color red(0), number 7 -> encoded high byte color, low byte number
  const topOfDiscard = (0 << 8) | 7;

  const claimBase: Omit<MoveClaim, "playedCard"> = {
    system: "PlayCardSystem",
    topOfDiscard,
    activeColor: 0, // red active
    roomId: "room-1",
    player: ALICE,
  };

  it("produces a verifiable attestation for a legal play (color match)", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(hand, ownerCondition);
    // card 10 is red, active color is red -> legal
    const att = await secrets.verify(sealed, { ...claimBase, playedCard: 10 });

    expect(att.signer.toLowerCase()).toBe(secrets.signerAddress.toLowerCase());
    expect(att.litActionCid).toBe("local:LocalSecrets");

    const fields = decodeAttestationPayload(att.payload);
    expect(fields.player.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(fields.playedCard).toBe(10);
    expect(fields.system).toBe("PlayCardSystem");
    expect(fields.validUntil).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));

    // signature recovers to the signer over EIP-191(keccak256(payload))
    const ok = await verifyMessage({
      address: att.signer,
      message: { raw: attestationDigest(att.payload) },
      signature: att.signature,
    });
    expect(ok).toBe(true);
  });

  it("produces an attestation for a wild card play", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(hand, ownerCondition);
    const att = await secrets.verify(sealed, { ...claimBase, playedCard: 12, activeColor: 3 });
    expect(decodeAttestationPayload(att.payload).playedCard).toBe(12);
  });

  it("rejects an illegal play with ILLEGAL_MOVE and no signature", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(hand, ownerCondition);
    // card 11 is blue/2; active color red, discard number 7 -> illegal
    await expect(secrets.verify(sealed, { ...claimBase, playedCard: 11 })).rejects.toMatchObject({
      code: "ILLEGAL_MOVE",
    });
  });

  it("rejects a play of a card not in the hand", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(hand, ownerCondition);
    await expect(secrets.verify(sealed, { ...claimBase, playedCard: 99 })).rejects.toMatchObject({
      code: "ILLEGAL_MOVE",
    });
  });

  it("produces a fresh, non-colliding random nonce per attestation (replay-resistant)", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(hand, ownerCondition);
    const a = await secrets.verify(sealed, { ...claimBase, playedCard: 10 });
    const b = await secrets.verify(sealed, { ...claimBase, playedCard: 10 });
    const na = decodeAttestationPayload(a.payload).nonce;
    const nb = decodeAttestationPayload(b.payload).nonce;
    // Two verifies of the same move must not share a nonce, so they cannot
    // produce identical/replayable attestations.
    expect(nb).not.toBe(na);
    // Random 256-bit nonces are not a tiny counter near 0.
    expect(na).toBeGreaterThan(1_000_000_000n);
    expect(nb).toBeGreaterThan(1_000_000_000n);
    // The whole signed payloads differ (nonce is part of the signed bytes).
    expect(a.payload).not.toBe(b.payload);
  });
});

describe("LocalSecrets default predicate fails closed (M2)", () => {
  it("denies reveal when the owner state is missing (no state[method])", async () => {
    const secrets = new LocalSecrets();
    const sealed = await secrets.seal(new Uint8Array([1, 2, 3]), ownerCondition);
    // No `state.ownerOf` resolved -> owner unknown -> must DENY (fail closed),
    // not let the caller claim ownership.
    await expect(secrets.reveal(sealed, { caller: ALICE, state: {} })).rejects.toMatchObject({
      code: "REVEAL_DENIED",
    });
    // Also when state is entirely absent.
    await expect(secrets.reveal(sealed, { caller: ALICE })).rejects.toMatchObject({
      code: "REVEAL_DENIED",
    });
  });
});
