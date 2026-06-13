import { usdcToWei } from "@nexus/core";
import type { RelayerCapabilities } from "@nexus/relayer";
import { type Hex, NexusError, asAddress } from "@nexus/types";
import type {
  Challenge402,
  FacilitatorAdapter,
  PaymentRequest,
  Redemption,
  Settlement,
} from "../ports/facilitator.js";
import { DEFAULT_NONCE_TTL_MS, InMemoryNonceStore, type NonceStore } from "./nonce-store.js";
import { type ReceiptReaderClient, verifyTransferOnChain } from "./verify.js";

export interface DelegationFacilitatorConfig {
  /**
   * Relayer capabilities — the SOURCE OF TRUTH for the payment token address and
   * targetAddress. The 402 `token` is resolved from `caps.tokens[symbol]`, never
   * hardcoded (backend spec §4.1 / conventions). May be a value or a resolver.
   */
  capabilities: RelayerCapabilities | (() => Promise<RelayerCapabilities>);
  /**
   * A viem public client (or the narrow `ReceiptReaderClient` port) on Base used
   * by `verify()` to read the settlement receipt. REAL on-chain read in prod;
   * injected with a known receipt in tests.
   */
  publicClient: ReceiptReaderClient;
  /** Replay-protection nonce store. Defaults to in-memory. */
  nonceStore?: NonceStore;
  /** Challenge TTL in ms. Defaults to {@link DEFAULT_NONCE_TTL_MS}. */
  ttlMs?: number;
  /**
   * Optional allowlist check: does `recipient` belong to `payer`'s AllowedTargets
   * budget caveat? The on-chain `AllowedTargetsEnforcer` is authoritative; this
   * is a pre-submit, defense-in-depth check. Defaults to allow-all (the chain
   * enforces).
   */
  authorizeRecipient?: (req: PaymentRequest) => boolean;
}

/**
 * The default, delegation-aware facilitator (backend spec §4.3). Unlike a
 * classic x402 facilitator that expects a fresh payment signature, this accepts
 * a *redemption of the player's session delegation*, bounded by the budget
 * caveats they approved once at `joinRoom()`.
 *
 * `challenge()` is fully real (capabilities-derived token, minted nonce).
 * `verify()` runs the real on-chain receipt confirmation via the injected
 * `publicClient` — only the chain client is injected for tests.
 */
export class DelegationFacilitator implements FacilitatorAdapter {
  private readonly nonceStore: NonceStore;
  private readonly ttlMs: number;
  private caps?: RelayerCapabilities;
  /** Idempotency: nonce -> settled result, so a re-delivered webhook is a no-op. */
  private readonly settled = new Map<Hex, Settlement>();

  constructor(private readonly cfg: DelegationFacilitatorConfig) {
    this.nonceStore = cfg.nonceStore ?? new InMemoryNonceStore();
    this.ttlMs = cfg.ttlMs ?? DEFAULT_NONCE_TTL_MS;
    if (typeof cfg.capabilities !== "function") this.caps = cfg.capabilities;
  }

  private async capabilities(): Promise<RelayerCapabilities> {
    if (this.caps) return this.caps;
    const fn = this.cfg.capabilities;
    if (typeof fn !== "function") {
      this.caps = fn;
      return this.caps;
    }
    this.caps = await fn();
    return this.caps;
  }

  /**
   * `challenge()` per the FacilitatorAdapter port. Synchronous from the caller's
   * view modulo the (cached) capabilities resolution — no settlement chain call.
   */
  async challenge(req: PaymentRequest): Promise<Challenge402> {
    const caps = await this.capabilities();
    const tokenAddr = caps.tokens[req.token];
    if (!tokenAddr) {
      throw new NexusError(
        "CAPABILITIES_UNAVAILABLE",
        `token ${req.token} not offered by relayer capabilities`,
      );
    }
    if (this.cfg.authorizeRecipient && !this.cfg.authorizeRecipient(req)) {
      throw new NexusError(
        "RECIPIENT_NOT_ALLOWED",
        `recipient ${req.recipient} not in payer's allowed targets`,
      );
    }

    const price = usdcToWei(req.amount).toString();
    const now = Date.now();
    const record = this.nonceStore.issue({
      payer: asAddress(req.payer),
      price,
      recipient: asAddress(req.recipient),
      expiresAt: now + this.ttlMs,
    });

    return {
      scheme: "x402",
      price,
      token: asAddress(tokenAddr) as Hex,
      tokenSymbol: req.token,
      recipient: asAddress(req.recipient),
      chain: "base",
      nonce: record.nonce,
      expiresAt: record.expiresAt,
      facilitator: "nexus",
    };
  }

  /**
   * `verify()` per the port. Single-uses the nonce (replay protection), then
   * confirms the USDC `Transfer` on Base via the injected client. Idempotent:
   * a re-delivered webhook returns the cached Settlement without re-consuming.
   */
  async verify(redemption: Redemption): Promise<Settlement> {
    const cached = this.settled.get(redemption.nonce);
    if (cached) return cached;

    if (!redemption.txHash) {
      throw new NexusError(
        "SETTLEMENT_FAILED",
        `redemption ${redemption.nonce} has no txHash to verify`,
        { retryable: true },
      );
    }

    // Single-use the nonce. Throws REPLAY / CHALLENGE_EXPIRED / unknown-nonce.
    const record = this.nonceStore.consume(redemption.nonce);
    const caps = await this.capabilities();
    const tokenAddr = caps.tokens.USDC;
    if (!tokenAddr) {
      throw new NexusError("CAPABILITIES_UNAVAILABLE", "USDC token address unavailable");
    }

    try {
      const settlement = await verifyTransferOnChain(this.cfg.publicClient, {
        txHash: redemption.txHash,
        token: asAddress(tokenAddr) as Hex,
        payer: record.payer,
        recipient: record.recipient,
        price: record.price,
        nonce: redemption.nonce,
      });
      this.settled.set(redemption.nonce, settlement);
      return settlement;
    } catch (err) {
      // Roll the nonce back so a transient receipt-read failure can be retried.
      record.used = false;
      throw err;
    }
  }
}
