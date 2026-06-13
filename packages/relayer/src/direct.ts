import { NexusError, type Address, type Hex, asAddress } from "@nexus/types";
import { BaseError, type Account, type Chain, type PublicClient, type WalletClient, type Transport } from "viem";
import type {
  Bundle,
  BundleHandle,
  Eip7702Authorization,
  RelayerAdapter,
  RelayerCapabilities,
  StatusEvent,
  Unsubscribe,
  UpgradeResult,
} from "./port.js";

export interface DirectRelayerConfig {
  /** A viem wallet client bound to a funded account (the redeemer/self-relayer). */
  wallet: WalletClient<Transport, Chain, Account>;
  /** A viem public client on the same chain for receipts. */
  publicClient: PublicClient<Transport, Chain>;
  /** USDC address on the active chain (read from chain config / capabilities upstream). */
  usdc: Address;
  /**
   * The address redemptions are addressed `to`. For self-relay this is the
   * redeemer account itself (it submits the redemption directly).
   */
  targetAddress?: Address;
}

/**
 * A LIVE relayer that broadcasts real transactions with a funded key. This is
 * not a mock: every `submitBundle` sends actual on-chain transactions and waits
 * for real receipts. It is the zero-credential default for tests and local/dev
 * deployments where no external relayer account exists. `OneShotRelayer` is the
 * production drop-in when a 1Shot account is configured.
 */
export class DirectRelayer implements RelayerAdapter {
  private readonly listeners = new Set<(e: StatusEvent) => void>();
  private seq = 0;

  constructor(private readonly cfg: DirectRelayerConfig) {}

  async getCapabilities(): Promise<RelayerCapabilities> {
    const me = asAddress(this.cfg.wallet.account.address);
    return {
      chains: [this.cfg.publicClient.chain.name],
      tokens: { USDC: this.cfg.usdc },
      feeCollector: me,
      targetAddress: this.cfg.targetAddress ?? me,
    };
  }

  async submitBundle(bundle: Bundle): Promise<BundleHandle> {
    const bundleId = `direct-${Date.now()}-${this.seq++}`;
    if (bundle.encodedTxns.length === 0) {
      throw new NexusError("RELAYER_FAILED", "bundle has no transactions");
    }
    let lastHash: Hex | undefined;
    // Self-relay submits each encoded call as a real transaction, in order.
    for (const call of bundle.encodedTxns) {
      try {
        const hash = (await this.cfg.wallet.sendTransaction({
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
        } as never)) as Hex;
        lastHash = hash;
        // Fire-and-forget receipt watcher → terminal StatusEvent.
        void this.watch(bundleId, hash);
      } catch (err) {
        this.emit({ bundleId, status: "failed", revert: stringifyErr(err) });
        throw new NexusError("RELAYER_FAILED", `submit failed: ${stringifyErr(err)}`, {
          cause: err,
          retryable: true,
        });
      }
    }
    return { bundleId, txHash: lastHash };
  }

  private async watch(bundleId: string, hash: Hex): Promise<void> {
    try {
      const receipt = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        this.emit({
          bundleId,
          status: "mined",
          txHash: hash,
          blockNumber: receipt.blockNumber,
        });
      } else {
        this.emit({ bundleId, status: "failed", txHash: hash, revert: "execution reverted" });
      }
    } catch (err) {
      this.emit({ bundleId, status: "failed", txHash: hash, revert: stringifyErr(err) });
    }
  }

  onStatus(cb: (e: StatusEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async upgradeEOA(auth: Eip7702Authorization): Promise<UpgradeResult> {
    // EIP-7702: attach the signed authorization to a (no-op) transaction so the
    // EOA gains smart-account code at the same address. The authorization must be
    // signed by the EOA being upgraded.
    try {
      const hash = (await this.cfg.wallet.sendTransaction({
        to: auth.account,
        value: 0n,
        // viem reads authorizationList for EIP-7702; the caller provides a signed tuple.
        authorizationList: [JSON.parse(auth.signedAuth)],
      } as never)) as Hex;
      await this.cfg.publicClient.waitForTransactionReceipt({ hash });
      return { account: auth.account, txHash: hash };
    } catch (err) {
      throw new NexusError("RELAYER_FAILED", `7702 upgrade failed: ${stringifyErr(err)}`, {
        cause: err,
        retryable: true,
      });
    }
  }

  private emit(e: StatusEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/**
 * Surface the revert data hex (the 4-byte custom-error selector + args) so the
 * SDK/test layer can decode it structurally against the known error ABIs. We do
 * NOT decode here — the relayer is game-agnostic and must not embed game ABIs.
 */
export function revertDataOf(err: unknown): Hex | undefined {
  if (err instanceof BaseError) {
    const walked = err.walk((e) => typeof (e as { data?: unknown }).data === "string");
    const data = (walked as { data?: unknown } | null)?.data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
  }
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
  }
  return undefined;
}

function stringifyErr(err: unknown): string {
  const data = revertDataOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  return data ? `${msg} [revert ${data}]` : msg;
}
