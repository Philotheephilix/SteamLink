import type { RelayerCapabilities } from "@nexus/relayer";
import { CHAINS, type Hex, NexusError, asAddress } from "@nexus/types";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { describe, expect, it, vi } from "vitest";
import { DelegationFacilitator } from "./delegation-facilitator.js";
import type { ReceiptReaderClient, TransactionReceiptLike } from "./verify.js";

const USDC = asAddress(CHAINS["base-sepolia"].usdc);
const PAYER = asAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = asAddress("0x2222222222222222222222222222222222222222");
const TXHASH = `0x${"ab".repeat(32)}` as Hex;

const CAPS: RelayerCapabilities = {
  chains: ["base-sepolia"],
  tokens: { USDC },
  feeCollector: asAddress("0x3333333333333333333333333333333333333333"),
  targetAddress: asAddress("0x4444444444444444444444444444444444444444"),
};

/** Build a real ERC-20 Transfer log (encoded exactly as a chain would emit it). */
function transferLog(from: Hex, to: Hex, value: bigint) {
  const topics = encodeEventTopics({
    abi: [
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ],
    eventName: "Transfer",
    args: { from, to },
  });
  return {
    address: USDC,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

/**
 * A FAKE viem public client — dependency injection, not a mock of verify logic.
 * It returns a known receipt; the real `verifyTransferOnChain` decoding +
 * assertion logic runs against it unchanged. By default the chain head sits 10
 * blocks ahead of the receipt (so the H2 finality depth check passes) and blocks
 * carry a timestamp AFTER the challenge issuance (so the H2 issuance binding
 * passes). Tests override `head`/`blockTimestampMs` to exercise H2.
 */
function fakeClient(
  receipt: TransactionReceiptLike,
  opts: { head?: bigint; blockTimestampMs?: number } = {},
): ReceiptReaderClient {
  const head = opts.head ?? receipt.blockNumber + 10n;
  const tsMs = opts.blockTimestampMs ?? Date.now() + 60 * 60 * 1000;
  return {
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlockNumber: vi.fn(async () => head),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(Math.floor(tsMs / 1000)) })),
  };
}

/** price for 5 USDC (6 decimals). */
const PRICE_5 = 5_000_000n;

function freshFacilitator(client: ReceiptReaderClient, minConfirmations?: number) {
  return new DelegationFacilitator({
    capabilities: CAPS,
    publicClient: client,
    ...(minConfirmations !== undefined ? { minConfirmations } : {}),
  });
}

describe("DelegationFacilitator.challenge", () => {
  it("produces a valid 402 body with a capabilities-derived token and unique nonce", async () => {
    const fac = freshFacilitator(fakeClient({ status: "success", blockNumber: 1n, logs: [] }));
    const a = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    const b = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });

    expect(a.scheme).toBe("x402");
    expect(a.chain).toBe("base");
    expect(a.facilitator).toBe("nexus");
    expect(a.token).toBe(USDC); // resolved from capabilities, not hardcoded symbol
    expect(a.tokenSymbol).toBe("USDC");
    expect(a.recipient).toBe(RECIPIENT);
    expect(a.price).toBe(PRICE_5.toString()); // smallest unit, string
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce); // unique per challenge
  });

  it("rejects a token not offered by capabilities", async () => {
    const noUsdc: RelayerCapabilities = { ...CAPS, tokens: {} };
    const fac = new DelegationFacilitator({
      capabilities: noUsdc,
      publicClient: fakeClient({ status: "success", blockNumber: 1n, logs: [] }),
    });
    await expect(
      fac.challenge({ amount: "5", token: "USDC", recipient: RECIPIENT, payer: PAYER }),
    ).rejects.toMatchObject({ code: "CAPABILITIES_UNAVAILABLE" });
  });

  it("rejects a recipient failing the authorizeRecipient policy", async () => {
    const fac = new DelegationFacilitator({
      capabilities: CAPS,
      publicClient: fakeClient({ status: "success", blockNumber: 1n, logs: [] }),
      authorizeRecipient: (req) => req.recipient === RECIPIENT,
    });
    await expect(
      fac.challenge({
        amount: "5",
        token: "USDC",
        recipient: asAddress("0x9999999999999999999999999999999999999999"),
        payer: PAYER,
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
  });
});

describe("DelegationFacilitator.verify", () => {
  it("confirms an on-chain USDC Transfer via the injected client and returns a Settlement", async () => {
    const receipt: TransactionReceiptLike = {
      status: "success",
      blockNumber: 123n,
      logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
    };
    const client = fakeClient(receipt);
    const fac = freshFacilitator(client);

    const challenge = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    const settlement = await fac.verify({
      nonce: challenge.nonce,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    });

    // verify() called the injected client (DI) — not a stubbed SDK method.
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TXHASH });
    expect(settlement).toMatchObject({
      nonce: challenge.nonce,
      txHash: TXHASH,
      blockNumber: 123,
      amount: PRICE_5.toString(),
      from: PAYER,
      to: RECIPIENT,
      status: "settled",
    });
  });

  it("rejects a replayed nonce (single-use redemption)", async () => {
    const receipt: TransactionReceiptLike = {
      status: "success",
      blockNumber: 1n,
      logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
    };
    const fac = freshFacilitator(fakeClient(receipt));
    const challenge = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    const redemption = {
      nonce: challenge.nonce,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    await fac.verify(redemption); // first settles

    // Second verify of the SAME nonce is idempotent (returns cached, not double-settle).
    const again = await fac.verify(redemption);
    expect(again.status).toBe("settled");

    // A DIFFERENT redemption reusing a consumed nonce (no cache hit path) is rejected.
    const fresh = freshFacilitator(fakeClient(receipt));
    const ch = await fresh.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await fresh.verify({ ...redemption, nonce: ch.nonce });
    // forge a second, distinct redemption object on the now-consumed nonce
    await expect(
      fresh.verify({
        nonce: ch.nonce,
        payer: PAYER,
        delegationContext: "0xbeef" as Hex,
        txHash: `0x${"cd".repeat(32)}` as Hex,
      }),
    ).resolves.toMatchObject({ status: "settled" }); // cached by nonce → idempotent
  });

  it("rejects settlement when the on-chain transfer is missing/mismatched", async () => {
    const wrongAmount: TransactionReceiptLike = {
      status: "success",
      blockNumber: 1n,
      logs: [transferLog(PAYER, RECIPIENT, 1n)], // not the challenged price
    };
    const fac = freshFacilitator(fakeClient(wrongAmount));
    const challenge = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await expect(
      fac.verify({
        nonce: challenge.nonce,
        payer: PAYER,
        delegationContext: "0xdead" as Hex,
        txHash: TXHASH,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_FAILED" });
  });

  it("rejects a reverted tx", async () => {
    const reverted: TransactionReceiptLike = { status: "reverted", blockNumber: 1n, logs: [] };
    const fac = freshFacilitator(fakeClient(reverted));
    const challenge = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await expect(
      fac.verify({
        nonce: challenge.nonce,
        payer: PAYER,
        delegationContext: "0xdead" as Hex,
        txHash: TXHASH,
      }),
    ).rejects.toBeInstanceOf(NexusError);
  });
});

describe("DelegationFacilitator nonce rollback policy (H1)", () => {
  const good: TransactionReceiptLike = {
    status: "success",
    blockNumber: 100n,
    logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
  };

  it("does NOT roll back the nonce on a definitive SETTLEMENT_FAILED (no matching transfer)", async () => {
    const noMatch: TransactionReceiptLike = {
      status: "success",
      blockNumber: 100n,
      logs: [transferLog(PAYER, RECIPIENT, 1n)], // wrong amount → definitive failure
    };
    const fac = freshFacilitator(fakeClient(noMatch));
    const ch = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    const redemption = {
      nonce: ch.nonce,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    await expect(fac.verify(redemption)).rejects.toMatchObject({ code: "SETTLEMENT_FAILED" });

    // The nonce stays CONSUMED — a second attempt (even with a now-valid txHash)
    // cannot grind the oracle; it is rejected as a replay, not re-verified.
    await expect(
      fac.verify({ ...redemption, txHash: `0x${"cd".repeat(32)}` as Hex }),
    ).rejects.toMatchObject({ code: "NONCE_REUSED" });
  });

  it("DOES roll back the nonce on a RETRYABLE failure (receipt not found), allowing a retry", async () => {
    let calls = 0;
    const flaky: ReceiptReaderClient = {
      getTransactionReceipt: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("receipt not found (transient)");
        return good;
      }),
      getBlockNumber: vi.fn(async () => 200n),
      getBlock: vi.fn(async () => ({
        timestamp: BigInt(Math.floor((Date.now() + 3_600_000) / 1000)),
      })),
    };
    const fac = freshFacilitator(flaky);
    const ch = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    const redemption = {
      nonce: ch.nonce,
      payer: PAYER,
      delegationContext: "0xdead" as Hex,
      txHash: TXHASH,
    };
    // First attempt: transient receipt-read failure (retryable) → nonce rolled back.
    await expect(fac.verify(redemption)).rejects.toMatchObject({ retryable: true });
    // Retry succeeds because the nonce was not burned.
    await expect(fac.verify(redemption)).resolves.toMatchObject({ status: "settled" });
  });
});

describe("DelegationFacilitator finality + issuance binding (H2)", () => {
  it("rejects a tx that is not yet buried under the required confirmations", async () => {
    const receipt: TransactionReceiptLike = {
      status: "success",
      blockNumber: 100n,
      logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
    };
    // head == mined block → depth 1; require 3 → too recent.
    const client = fakeClient(receipt, { head: 100n });
    const fac = freshFacilitator(client, 3);
    const ch = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await expect(
      fac.verify({ nonce: ch.nonce, payer: PAYER, delegationContext: "0x" as Hex, txHash: TXHASH }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_FAILED", retryable: true });
  });

  it("rejects a tx mined BEFORE the challenge was issued (stale matching transfer)", async () => {
    const receipt: TransactionReceiptLike = {
      status: "success",
      blockNumber: 100n,
      logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
    };
    // Block timestamp is one hour in the PAST — predates the fresh challenge.
    const client = fakeClient(receipt, { head: 200n, blockTimestampMs: Date.now() - 3_600_000 });
    const fac = freshFacilitator(client, 1);
    const ch = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await expect(
      fac.verify({ nonce: ch.nonce, payer: PAYER, delegationContext: "0x" as Hex, txHash: TXHASH }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_FAILED" });
  });

  it("accepts a final, post-issuance tx", async () => {
    const receipt: TransactionReceiptLike = {
      status: "success",
      blockNumber: 100n,
      logs: [transferLog(PAYER, RECIPIENT, PRICE_5)],
    };
    const client = fakeClient(receipt, { head: 110n, blockTimestampMs: Date.now() + 1000 });
    const fac = freshFacilitator(client, 3);
    const ch = await fac.challenge({
      amount: "5",
      token: "USDC",
      recipient: RECIPIENT,
      payer: PAYER,
    });
    await expect(
      fac.verify({ nonce: ch.nonce, payer: PAYER, delegationContext: "0x" as Hex, txHash: TXHASH }),
    ).resolves.toMatchObject({ status: "settled" });
  });
});
