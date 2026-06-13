import { buildRedeemCalldata, encodePermissionContext } from "@nexus/core";
import type { Bundle, RelayerAdapter } from "@nexus/relayer";
import { type Address, type Hex, NexusError } from "@nexus/types";
import type { RoomService } from "../rooms/RoomService.js";
import type { SessionStore } from "../rooms/store.js";
import type { SignedDelegation } from "../types.js";
import type { AwaitingRegistry } from "./awaiting.js";
import { normalizeSignedDelegation } from "./normalize.js";
import type { WebhookLedger } from "./webhook.js";

export interface MoveRequest {
  game: string;
  sessionId: string;
  /** Pre-encoded `World.call(systemId, innerCalldata)` execution from the SDK. */
  encodedExecution?: Hex;
  /** Or raw encoded txns the SDK already built. */
  encodedTxns?: { to: Address; data: Hex; value?: bigint }[];
  /** The authenticated caller (smart-account address). */
  caller: Address;
}

export interface MoveDeps {
  rooms: RoomService;
  store: SessionStore;
  relayer: RelayerAdapter;
  awaiting: AwaitingRegistry;
  ledger: WebhookLedger;
  webhookUrl?: string;
}

export interface Accepted {
  callId: string;
}

/**
 * The move lifecycle (phase-05 §4.7). Asserts the room is active and the caller a
 * member, loads the session's gameplay delegation context, submits a gameplay
 * bundle through the relayer, claims the bundle→room correlation BEFORE returning
 * (so an out-of-order webhook still resolves), and returns `{ callId }`. The SDK
 * awaits resolution via the webhook-driven `AwaitingRegistry`.
 */
export async function handleMove(req: MoveRequest, deps: MoveDeps): Promise<Accepted> {
  const session = await deps.store.get(req.sessionId);
  if (!session) throw new NexusError("SESSION_NOT_FOUND", `session ${req.sessionId} not found`);

  // room must be active and caller a member
  const state = deps.rooms.state(session.roomId);
  if (state !== "active") throw new NexusError("ROOM_CLOSED", `room not active (${state})`);
  if (session.player.toLowerCase() !== req.caller.toLowerCase()) {
    throw new NexusError("NOT_CONNECTED", "caller is not the session owner");
  }
  if (!deps.rooms.isMember(session.roomId, req.caller)) {
    throw new NexusError("ROOM_CLOSED", "caller is not a room member");
  }

  const delegationContext =
    "kind" in session.delegation.signed
      ? undefined
      : encodePermissionContext(
          normalizeSignedDelegation(session.delegation.signed as SignedDelegation),
        );

  // Build a REAL on-chain redemption. The relayer broadcasts `encodedTxns` as-is
  // (it does not wrap a delegationContext for self-relay), so the bundle MUST be a
  // `manager.redeemDelegations(permissionContext, execution)` call addressed to the
  // delegation manager — exactly the proven scripts/live flow. `session.delegation.to`
  // is the manager (validated to equal the relayer's targetAddress at join).
  let encodedTxns: { to: Address; data: Hex; value?: bigint }[];
  if (req.encodedTxns) {
    encodedTxns = req.encodedTxns;
  } else if (req.encodedExecution) {
    if (!delegationContext) {
      throw new NexusError(
        "INVALID_CONFIG",
        "move redemption requires a signed delegation (no permission context for relayer-ref session)",
      );
    }
    const redeemCalldata = buildRedeemCalldata(delegationContext, req.encodedExecution);
    encodedTxns = [{ to: session.delegation.to, data: redeemCalldata, value: 0n }];
  } else {
    encodedTxns = [];
  }
  if (encodedTxns.length === 0) {
    throw new NexusError("INVALID_CONFIG", "move has no encoded execution");
  }

  const bundle: Bundle = {
    delegationContext,
    encodedTxns,
    ...(deps.webhookUrl ? { destinationUrl: deps.webhookUrl } : {}),
  };
  const handle = await deps.relayer.submitBundle(bundle);

  // claim correlation at submit time so a webhook arriving before we register the
  // awaiting promise still resolves (resilience: ledger is the durable correlation).
  await deps.ledger.claim({
    bundleId: handle.bundleId,
    roomId: session.roomId,
    kind: "move",
    player: req.caller,
  });
  // pre-arm the awaiting promise (fire-and-forget; the gateway returns the callId).
  void deps.awaiting.register(handle.bundleId);

  return { callId: handle.bundleId };
}
