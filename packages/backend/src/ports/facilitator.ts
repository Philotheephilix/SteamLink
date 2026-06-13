import type { RelayerCapabilities } from "@nexus/relayer";
import type {
  Challenge402,
  FacilitatorAdapter,
  PaymentRequest,
  Redemption,
  Settlement,
} from "@nexus/server";
import { type Hex, NexusError, asAddress } from "@nexus/types";

/**
 * The `FacilitatorAdapter` port is owned by `@nexus/server` (where the real
 * `DelegationFacilitator` is built — Phase 07). We REUSE it here rather than
 * redefining it, so swapping the stub for the real facilitator is a zero-diff
 * change at the composition root.
 */
export type {
  FacilitatorAdapter,
  PaymentRequest,
  Challenge402,
  Redemption,
  Settlement,
} from "@nexus/server";
export { DelegationFacilitator } from "@nexus/server";

function microToHuman(price: string): string {
  return price; // already human in PaymentRequest.amount; stub echoes it
}

/**
 * A syntactically-valid stub facilitator (phase-05 §4.8). `challenge()` mints a
 * 402 with the token resolved from relayer capabilities (never hardcoded);
 * `verify()` resolves a trivial settlement from a mined webhook. Phase 07's
 * `DelegationFacilitator` (in `@nexus/server`) replaces this with no gateway diff.
 */
export class StubFacilitator implements FacilitatorAdapter {
  private seq = 0;
  private readonly issued = new Map<Hex, { amount: string; recipient: Hex; token: Hex }>();

  constructor(
    private readonly capabilities: RelayerCapabilities | (() => Promise<RelayerCapabilities>),
    opts: { allowUnsafeDev?: boolean } = {},
  ) {
    // C6: this stub does NOT verify anything on-chain. It must never be the
    // money-safe default; refuse to construct unless the caller explicitly opts
    // into unsafe dev behaviour.
    if (!opts.allowUnsafeDev) {
      throw new NexusError(
        "INVALID_CONFIG",
        "StubFacilitator does not verify settlements on-chain and is unsafe for money. " +
          "Construct it only with { allowUnsafeDev: true }, or use DelegationFacilitator.",
      );
    }
  }

  private async caps(): Promise<RelayerCapabilities> {
    return typeof this.capabilities === "function" ? this.capabilities() : this.capabilities;
  }

  async challenge(req: PaymentRequest): Promise<Challenge402> {
    const caps = await this.caps();
    const tokenAddr = caps.tokens[req.token];
    if (!tokenAddr) {
      throw new NexusError(
        "CAPABILITIES_UNAVAILABLE",
        `token ${req.token} not in relayer capabilities`,
      );
    }
    const nonce = `0x${(++this.seq).toString(16).padStart(64, "0")}` as Hex;
    const token = asAddress(tokenAddr) as Hex;
    this.issued.set(nonce, {
      amount: microToHuman(req.amount),
      recipient: req.recipient,
      token,
    });
    return {
      scheme: "x402",
      price: req.amount,
      token,
      tokenSymbol: req.token,
      recipient: req.recipient,
      chain: "base",
      nonce,
      expiresAt: Date.now() + 5 * 60_000,
      facilitator: "nexus",
    };
  }

  /**
   * C6: NEVER fabricate `status:"settled"`. This stub cannot read the chain, so
   * it cannot confirm a settlement — it always rejects. Use `DelegationFacilitator`
   * (with a real publicClient) for any path that moves money.
   */
  async verify(redemption: Redemption): Promise<Settlement> {
    const issued = this.issued.get(redemption.nonce);
    if (!issued) throw new NexusError("NONCE_REUSED", `unknown/used nonce ${redemption.nonce}`);
    // Burn the nonce so a replay is also rejected, but DO NOT claim a settlement.
    this.issued.delete(redemption.nonce);
    throw new NexusError(
      "SETTLEMENT_FAILED",
      "StubFacilitator cannot confirm settlement on-chain — no fabricated settlements (C6)",
    );
  }
}
