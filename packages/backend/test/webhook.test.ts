import type { Hex } from "@nexus/types";
import { describe, expect, it } from "vitest";
import {
  AwaitingRegistry,
  MemoryWebhookLedger,
  WEBHOOK_SIG_HEADER,
  WebhookHandler,
  computePayout,
  computeRefunds,
  hmacWebhookVerifier,
  rakeBps,
  signWebhookBody,
} from "../src/index.js";

const TX = `0x${"ab".repeat(32)}` as Hex;
/** A permissive verifier for tests that focus on resolution/dedupe, not auth. */
const ALLOW = () => true;

describe("webhook ingestion", () => {
  it("resolves a pending move/charge call via the bundleId correlation", async () => {
    const ledger = new MemoryWebhookLedger();
    const awaiting = new AwaitingRegistry();
    const webhook = new WebhookHandler(ledger, ALLOW);
    webhook.onStatus((e) => awaiting.ingest(e));

    // submit-time: claim the correlation + arm the awaiting promise
    await ledger.claim({ bundleId: "b-1", roomId: "room-1", kind: "move" });
    const pending = awaiting.register("b-1");

    const result = await webhook.ingest({
      bundleId: "b-1",
      status: "mined",
      txHash: TX,
      blockNumber: 42,
    });
    expect(result).toMatchObject({ ok: true, deduped: false });
    expect(result.correlation).toMatchObject({ roomId: "room-1", kind: "move" });

    const res = await pending;
    expect(res).toMatchObject({ status: "mined", txHash: TX });
  });

  it("dedupes a re-delivered webhook by bundleId (idempotent, no double resolve)", async () => {
    const ledger = new MemoryWebhookLedger();
    const awaiting = new AwaitingRegistry();
    const webhook = new WebhookHandler(ledger, ALLOW);
    let emitted = 0;
    webhook.onStatus((e) => {
      emitted++;
      awaiting.ingest(e);
    });

    await ledger.claim({ bundleId: "b-2", kind: "charge" });
    const first = await webhook.ingest({ bundleId: "b-2", status: "mined", txHash: TX });
    const second = await webhook.ingest({ bundleId: "b-2", status: "mined", txHash: TX });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(emitted).toBe(1); // re-delivery does NOT re-emit a StatusEvent
  });

  it("resolves out-of-order (webhook before register)", async () => {
    const awaiting = new AwaitingRegistry();
    awaiting.ingest({ bundleId: "b-3", status: "mined", txHash: TX });
    const res = await awaiting.register("b-3");
    expect(res.status).toBe("mined");
  });

  it("rejects an unverified webhook", async () => {
    const ledger = new MemoryWebhookLedger();
    const webhook = new WebhookHandler(ledger, () => false);
    await expect(webhook.ingest({ bundleId: "b-4", status: "mined" })).rejects.toThrow(
      /check failed/i,
    );
  });
});

describe("webhook verifier is mandatory + HMAC (C2)", () => {
  it("WebhookHandler throws if no verifier is supplied (fails closed)", () => {
    const ledger = new MemoryWebhookLedger();
    // @ts-expect-error — intentionally omitting the required verifier
    expect(() => new WebhookHandler(ledger)).toThrow(/requires an explicit verifier/i);
  });

  it("accepts a delivery with a valid HMAC over the raw body and rejects a bad one", async () => {
    const secret = "shhh";
    const ledger = new MemoryWebhookLedger();
    const webhook = new WebhookHandler(ledger, hmacWebhookVerifier(secret));
    const rawBody = JSON.stringify({ bundleId: "b-h", status: "mined", txHash: TX });
    const payload = JSON.parse(rawBody);

    // Bad signature → rejected.
    await expect(
      webhook.ingest(payload, { [WEBHOOK_SIG_HEADER]: "0xdeadbeef" }, rawBody),
    ).rejects.toThrow(/check failed/i);

    // Correct signature → accepted.
    const sig = signWebhookBody(secret, rawBody);
    const ok = await webhook.ingest(payload, { [WEBHOOK_SIG_HEADER]: sig }, rawBody);
    expect(ok.ok).toBe(true);
  });

  it("fails closed when no secret is configured", async () => {
    const ledger = new MemoryWebhookLedger();
    const webhook = new WebhookHandler(ledger, hmacWebhookVerifier(undefined));
    const rawBody = JSON.stringify({ bundleId: "b-n", status: "mined" });
    await expect(
      webhook.ingest(JSON.parse(rawBody), { [WEBHOOK_SIG_HEADER]: "0x00" }, rawBody),
    ).rejects.toThrow(/check failed/i);
  });
});

describe("mined charge only settles after on-chain verify (C1)", () => {
  /** A facilitator whose verify() result the test controls. */
  function fac(result: "settled" | "fail", from: Hex, payer: Hex) {
    return {
      challenge: async () => {
        throw new Error("unused");
      },
      verify: async (r: { nonce: Hex; txHash?: Hex }) => {
        if (result === "fail") {
          throw new Error("no matching transfer on-chain");
        }
        return {
          nonce: r.nonce,
          txHash: (r.txHash ?? TX) as Hex,
          blockNumber: 1,
          amount: "5",
          token: `0x${"cc".repeat(20)}` as Hex,
          from,
          to: `0x${"dd".repeat(20)}` as Hex,
          status: "settled" as const,
        };
      },
    };
  }

  const NONCE = `0x${"01".repeat(32)}` as Hex;
  const PAYER = `0x${"ab".repeat(20)}` as Hex;

  it("downgrades a mined charge to failed when the facilitator cannot confirm settlement", async () => {
    const ledger = new MemoryWebhookLedger();
    const awaiting = new AwaitingRegistry();
    const webhook = new WebhookHandler(ledger, ALLOW, {
      facilitator: fac("fail", PAYER, PAYER),
    });
    webhook.onStatus((e) => awaiting.ingest(e));

    await ledger.claim({
      bundleId: "c-1",
      kind: "charge",
      nonce: NONCE,
      payer: PAYER,
      txHash: TX,
    });
    const pending = awaiting.register("c-1");
    await webhook.ingest({ bundleId: "c-1", status: "mined", txHash: TX });
    // The mined webhook is DOWNGRADED to failed (no fabricated success), so the
    // awaiting promise rejects rather than reporting a settled charge.
    await expect(pending).rejects.toThrow();
  });

  it("resolves a mined charge as mined ONLY after a confirmed settlement from the payer", async () => {
    const ledger = new MemoryWebhookLedger();
    const awaiting = new AwaitingRegistry();
    const webhook = new WebhookHandler(ledger, ALLOW, {
      facilitator: fac("settled", PAYER, PAYER),
    });
    webhook.onStatus((e) => awaiting.ingest(e));

    await ledger.claim({
      bundleId: "c-2",
      kind: "charge",
      nonce: NONCE,
      payer: PAYER,
      txHash: TX,
    });
    const pending = awaiting.register("c-2");
    await webhook.ingest({ bundleId: "c-2", status: "mined", txHash: TX });
    const res = await pending;
    expect(res.status).toBe("mined");
  });

  it("downgrades when the confirmed settlement.from != the charge payer", async () => {
    const ledger = new MemoryWebhookLedger();
    const awaiting = new AwaitingRegistry();
    const OTHER = `0x${"99".repeat(20)}` as Hex;
    const webhook = new WebhookHandler(ledger, ALLOW, {
      facilitator: fac("settled", OTHER, PAYER),
    });
    webhook.onStatus((e) => awaiting.ingest(e));

    await ledger.claim({
      bundleId: "c-3",
      kind: "charge",
      nonce: NONCE,
      payer: PAYER,
      txHash: TX,
    });
    const pending = awaiting.register("c-3");
    await webhook.ingest({ bundleId: "c-3", status: "mined", txHash: TX });
    await expect(pending).rejects.toThrow();
  });
});

describe("pot rake math", () => {
  it("winner payout = pot − rake; sum == pot", () => {
    const split = computePayout("10", { pot: { type: "winner-take-all", rake: "0.1" } });
    expect(split.winner).toBe("9");
    expect(split.rake).toBe("1");
  });

  it("rake as integer basis points (M5) — pure bigint, no float drift", () => {
    // 250 bps = 2.5% of 100 = 2.5 exactly.
    const split = computePayout("100", { pot: { type: "winner-take-all", rake: "250" } });
    expect(split.rake).toBe("2.5");
    expect(split.winner).toBe("97.5");
  });

  it("decimal rake string is converted to bps deterministically (back-compat, M5)", () => {
    expect(rakeBps({ pot: { type: "winner-take-all", rake: "0.1" } })).toBe(1000n);
    expect(rakeBps({ pot: { type: "winner-take-all", rake: "0.025" } })).toBe(250n);
    expect(rakeBps({ pot: { type: "winner-take-all", rake: "1000" } })).toBe(1000n);
    expect(rakeBps(undefined)).toBe(0n);
  });

  it("rejects a finer-than-1bp decimal rather than rounding a money ratio (M5)", () => {
    expect(() => rakeBps({ pot: { type: "winner-take-all", rake: "0.00001" } })).toThrow();
  });

  it("rejects a rake >= 100% (M5)", () => {
    expect(() => rakeBps({ pot: { type: "winner-take-all", rake: "10000" } })).toThrow();
  });

  it("pro-rata refund sums to the pot", () => {
    const shares = computeRefunds("10", ["0xa", "0xb", "0xc"]);
    const sum = shares.reduce((acc, s) => acc + Number(s.amount), 0);
    expect(sum).toBeCloseTo(10, 6);
  });
});
