import { encodePermissionContext } from "@nexus/core";
import type { Bundle, RelayerAdapter } from "@nexus/relayer";
import type { Challenge402, FacilitatorAdapter } from "@nexus/server";
import { type Address, type Hex, NexusError } from "@nexus/types";
import type { RoomService } from "../rooms/RoomService.js";
import type { SessionStore } from "../rooms/store.js";
import type { SignedDelegation } from "../types.js";
import type { AwaitingRegistry } from "./awaiting.js";
import type { Accepted } from "./move.js";
import type { WebhookLedger } from "./webhook.js";

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

export interface ChargeRequest {
  game: string;
  sessionId: string;
  amount: string;
  to: Address;
  reason?: string;
  caller: Address;
}

export interface ChargeDeps {
  rooms: RoomService;
  store: SessionStore;
  relayer: RelayerAdapter;
  facilitator: FacilitatorAdapter;
  awaiting: AwaitingRegistry;
  ledger: WebhookLedger;
  webhookUrl?: string;
}

export interface ChargeAccepted extends Accepted {
  /** The 402 challenge that gates the charge (replayed to the SDK). */
  challenge: Challenge402;
}

function usdcToUnits(human: string): bigint {
  const [whole, frac = ""] = human.split(".");
  const padded = `${frac}000000`.slice(0, 6);
  return BigInt(whole || "0") * 10n ** 6n + BigInt(padded || "0");
}

/**
 * The charge lifecycle (phase-05 §4.8) — routing + session plumbing. Issues a 402
 * via the facilitator (stubbed in phase-05), redeems the session's BUDGET caveat
 * group (not gameplay) to transfer USDC to the recipient through the relayer, and
 * returns `{ callId, challenge }`. `Facilitator.verify()` runs on the mined webhook.
 */
export async function handleCharge(req: ChargeRequest, deps: ChargeDeps): Promise<ChargeAccepted> {
  const session = await deps.store.get(req.sessionId);
  if (!session) throw new NexusError("SESSION_NOT_FOUND", `session ${req.sessionId} not found`);

  const state = deps.rooms.state(session.roomId);
  if (state !== "active") throw new NexusError("ROOM_CLOSED", `room not active (${state})`);
  if (session.player.toLowerCase() !== req.caller.toLowerCase()) {
    throw new NexusError("NOT_CONNECTED", "caller is not the session owner");
  }

  const caps = await deps.relayer.getCapabilities();
  const usdc = caps.tokens.USDC;
  if (!usdc) throw new NexusError("CAPABILITIES_UNAVAILABLE", "USDC token unavailable");

  // 402 challenge — token resolved from capabilities by the facilitator.
  const challenge = await deps.facilitator.challenge({
    game: req.game,
    roomId: session.roomId,
    amount: req.amount,
    token: "USDC",
    recipient: req.to,
    reason: req.reason,
    payer: session.player,
  });

  // redeem the BUDGET caveat group — same signed delegation, budget path.
  const delegationContext =
    "kind" in session.delegation.signed
      ? undefined
      : encodePermissionContext(session.delegation.signed as SignedDelegation);

  const { encodeFunctionData } = await import("viem");
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [req.to, usdcToUnits(req.amount)],
  }) as Hex;

  const bundle: Bundle = {
    delegationContext,
    encodedTxns: [{ to: usdc, data, value: 0n }],
    ...(deps.webhookUrl ? { destinationUrl: deps.webhookUrl } : {}),
  };
  const handle = await deps.relayer.submitBundle(bundle);
  // C1: persist the redemption identity so a mined webhook is confirmed on-chain
  // (facilitator.verify) BEFORE the charge is resolved as settled.
  await deps.ledger.claim({
    bundleId: handle.bundleId,
    roomId: session.roomId,
    kind: "charge",
    player: req.caller,
    nonce: challenge.nonce,
    payer: session.player as Hex,
    ...(delegationContext ? { delegationContext } : {}),
    ...(handle.txHash ? { txHash: handle.txHash } : {}),
  });
  void deps.awaiting.register(handle.bundleId);

  return { callId: handle.bundleId, challenge };
}
