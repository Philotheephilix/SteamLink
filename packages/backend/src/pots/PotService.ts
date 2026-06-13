import type { EconomyConfig } from "@nexus/core";
import { encodePermissionContext } from "@nexus/core";
import type { Bundle, RelayerAdapter } from "@nexus/relayer";
import { type Address, type Hex, NexusError, asAddress } from "@nexus/types";
import { encodeFunctionData } from "viem";
import type { SessionStore } from "../rooms/store.js";
import type { Payout, PotRef, Refund, RoomId } from "../types.js";
import type { RelayerRef, SignedDelegation } from "../types.js";
import { computePayout, computeRefunds } from "./rake.js";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const DECIMALS = 6n;
function usdcToUnits(human: string): bigint {
  const [whole, frac = ""] = human.split(".");
  const padded = `${frac}000000`.slice(0, Number(DECIMALS));
  return BigInt(whole || "0") * 10n ** DECIMALS + BigInt(padded || "0");
}

export interface PotServiceDeps {
  store: SessionStore;
  relayer: RelayerAdapter;
  /** game name -> economy (rake). */
  economyOf: (roomId: RoomId) => EconomyConfig | undefined;
  /** Tracked pot balance per room (funded by entry charges). */
  potBalance: (roomId: RoomId) => string;
}

/**
 * Pots are MetaMask Smart Account escrows with their OWN delegation, so payout is
 * trustless and admin-keyless (backend spec §4.2). `settlePot`/`refundProRata`
 * build USDC transfer calldata from the pot account and submit it through the
 * relayer by redeeming the pot's delegation — never a custodial transfer.
 */
export class PotService {
  constructor(private readonly deps: PotServiceDeps) {}

  /**
   * Open a pot escrow for a room. The pot account + its signed delegation are
   * provided by the caller (the smart-account escrow is created off this path in
   * prod); here we record it in the session store's pot map.
   */
  async openPot(
    roomId: RoomId,
    account: Address,
    delegation: SignedDelegation | RelayerRef,
  ): Promise<PotRef> {
    const pot: PotRef = { roomId, account, delegation, participants: [] };
    await this.deps.store.setPot(roomId, pot);
    return pot;
  }

  /** Record a participant who funded the pot (for pro-rata refunds). */
  async addParticipant(roomId: RoomId, player: Address): Promise<void> {
    const pot = await this.deps.store.potMap(roomId);
    if (!pot) throw new NexusError("SESSION_NOT_FOUND", `no pot for room ${roomId}`);
    if (!pot.participants.some((p) => p.toLowerCase() === player.toLowerCase())) {
      pot.participants.push(player);
      await this.deps.store.setPot(roomId, pot);
    }
  }

  /**
   * Settle: pay the winner pot − rake by redeeming the pot's own delegation
   * through the relayer. Returns the payout (with the relayer bundle id).
   */
  async settlePot(roomId: RoomId, winner: Address): Promise<Payout> {
    const pot = await this.deps.store.potMap(roomId);
    if (!pot) throw new NexusError("SESSION_NOT_FOUND", `no pot for room ${roomId}`);

    const economy = this.deps.economyOf(roomId);
    const split = computePayout(this.deps.potBalance(roomId), economy);
    const caps = await this.deps.relayer.getCapabilities();
    const usdc = caps.tokens.USDC;
    if (!usdc) throw new NexusError("CAPABILITIES_UNAVAILABLE", "USDC token unavailable");

    const bundle = this.buildTransferBundle(
      pot,
      usdc,
      winner,
      split.winner,
      caps.targetAddress,
      // H4: deterministic per (pot, recipient, round=settle) — a retried settle
      // cannot double-pay the winner.
      `pot:${roomId}:settle:${winner.toLowerCase()}`,
    );
    const handle = await this.deps.relayer.submitBundle(bundle);
    return { winner, amount: split.winner, rake: split.rake, bundleId: handle.bundleId };
  }

  /** Pro-rata refund of an abandoned pot via relayed bundles (no custody). */
  async refundProRata(roomId: RoomId): Promise<Refund[]> {
    const pot = await this.deps.store.potMap(roomId);
    if (!pot) throw new NexusError("SESSION_NOT_FOUND", `no pot for room ${roomId}`);
    const caps = await this.deps.relayer.getCapabilities();
    const usdc = caps.tokens.USDC;
    if (!usdc) throw new NexusError("CAPABILITIES_UNAVAILABLE", "USDC token unavailable");

    const shares = computeRefunds(this.deps.potBalance(roomId), pot.participants);
    const refunds: Refund[] = [];
    for (const share of shares) {
      const bundle = this.buildTransferBundle(
        pot,
        usdc,
        asAddress(share.player),
        share.amount,
        caps.targetAddress,
        // H4: deterministic per (pot, recipient, round=refund) — a retried refund
        // submit cannot double-refund a participant.
        `pot:${roomId}:refund:${share.player.toLowerCase()}`,
      );
      const handle = await this.deps.relayer.submitBundle(bundle);
      refunds.push({
        player: asAddress(share.player),
        amount: share.amount,
        bundleId: handle.bundleId,
      });
    }
    return refunds;
  }

  private buildTransferBundle(
    pot: PotRef,
    usdc: Address,
    to: Address,
    amount: string,
    targetAddress: Address,
    idempotencyKey: string,
  ): Bundle {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, usdcToUnits(amount)],
    });
    const delegationContext =
      "kind" in pot.delegation
        ? undefined // relayer-side reference: relayer resolves it by ref
        : encodePermissionContext(pot.delegation as SignedDelegation);
    void targetAddress; // asserted by the relayer adapter against the delegation `to`
    return {
      delegationContext,
      encodedTxns: [{ to: usdc, data: data as Hex, value: 0n }],
      // H4: this is a MONEY bundle — the relayer must determine + assert the
      // target (hard reject if it can't), and dedupe by the idempotency key.
      requireTarget: true,
      idempotencyKey,
    };
  }
}
