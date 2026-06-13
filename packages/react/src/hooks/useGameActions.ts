import {
  buildGameplayCaveats,
  buildMoveExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  signDelegation,
} from "@nexus/core";
import type { SignedDelegation } from "@nexus/core";
import { NexusError } from "@nexus/types";
import type { Hex } from "@nexus/types";
import { useCallback, useRef, useState } from "react";
import type { PendingResolver, StatusEvent } from "../optimistic/reconcile.js";
import type { Row, Where } from "../transport.js";
import { useNexus } from "./useNexus.js";
import { useSession } from "./useSession.js";

let bundleCounter = 0;
function nextBundleId(): string {
  bundleCounter += 1;
  return `bundle-${Date.now().toString(36)}-${bundleCounter}`;
}

export interface MovePlan {
  /** Which table the optimistic overlay targets. */
  table: string;
  where: Where;
  /** Pure predicted transform over base rows. */
  mutate: (rows: Row[]) => Row[];
}

export interface MoveOptions {
  /** Optional pre-encoded inner system calldata; defaults to "0x". */
  systemCalldata?: Hex;
  /** Optional optimistic plan: applied immediately, rolled back on failure. */
  optimistic?: MovePlan;
  /** Room id for caveat compilation (turn/limit binding). */
  roomId?: bigint;
  /**
   * Max time (ms) to await a terminal status before the bundle is auto-failed:
   * its optimistic overlay is rolled back and the promise rejects with
   * `RELAYER_FAILED`, so a lost/never-acked submit can't leave a stuck row or a
   * promise that hangs forever. Default {@link DEFAULT_MOVE_TIMEOUT_MS} (60s).
   */
  timeoutMs?: number;
}

/** Default terminal-status timeout for a move bundle (ms). */
export const DEFAULT_MOVE_TIMEOUT_MS = 60_000;

export interface MoveResult {
  bundleId: string;
  /** The redemption calldata the engine produced. */
  calldata: Hex;
  system: string;
  status: StatusEvent["status"];
  txHash?: string;
}

export interface UseGameActionsResult {
  move: (system: string, systemId: Hex, options?: MoveOptions) => Promise<MoveResult>;
  isPending: boolean;
  pending: Array<{ bundleId: string; system: string }>;
  lastError: NexusError | null;
}

/**
 * Exposes `move`, which builds a redemption through the core delegation engine,
 * registers an optimistic overlay, submits through the transport, and awaits the
 * reconciler — resolving on `mined`, rejecting (typed NexusError) + rolling back
 * on `failed`. The prediction is consumed, not re-implemented, so client-only and
 * React callers reconcile identically.
 */
export function useGameActions(): UseGameActionsResult {
  const { config, manager } = useNexus();
  const { session } = useSession();
  const [pending, setPending] = useState<Array<{ bundleId: string; system: string }>>([]);
  const [lastError, setLastError] = useState<NexusError | null>(null);
  // Cache the signed delegation so we sign at most once per session.
  const signedRef = useRef<SignedDelegation | null>(null);
  const signedForRoom = useRef<bigint | null>(null);

  const move = useCallback(
    async (system: string, systemId: Hex, options: MoveOptions = {}): Promise<MoveResult> => {
      setLastError(null);
      const roomId = options.roomId ?? session?.roomId ?? 0n;
      const bundleId = nextBundleId();

      // 1. Optimistic apply (instant UI; no popup).
      if (options.optimistic) {
        manager.addOverlay(options.optimistic.table, options.optimistic.where, {
          bundleId,
          mutate: options.optimistic.mutate,
          status: "pending",
        });
      }

      try {
        // 2. Build the redemption via the core delegation engine.
        const signer = config.signer;
        if (!signer) throw new NexusError("NOT_CONNECTED", "no signer configured");

        if (!signedRef.current || signedForRoom.current !== roomId) {
          if (!session) throw new NexusError("SESSION_NOT_FOUND", "join a room first");
          const caveats = buildGameplayCaveats(
            {
              gameplay: {
                allowedSystems: session.perms.gameplay.allowedSystems as Hex[],
                turnBound: session.perms.gameplay.turnBound,
                expiresAt: session.perms.gameplay.expiresAt,
                maxActions: session.perms.gameplay.maxActions,
              },
              budget: {
                token: "USDC",
                totalCap: session.perms.budget.totalCap,
                perActionCap: session.perms.budget.perActionCap,
                allowedRecipients: session.perms.budget.allowedRecipients,
              },
            },
            config.addresses,
            roomId,
          );
          signedRef.current = await signDelegation(signer, {
            chainId: chainId(config.chain),
            delegationManager: config.addresses.delegationManager,
            delegate: signer.address,
            caveats,
          });
          signedForRoom.current = roomId;
        }

        const execution = buildMoveExecution(
          config.addresses,
          systemId,
          options.systemCalldata ?? "0x",
        );
        const permissionContext = encodePermissionContext(signedRef.current);
        const calldata = buildRedeemCalldata(permissionContext, execution);

        setPending((p) => [...p, { bundleId, system }]);

        // 3. Submit + await reconciliation.
        const timeoutMs = options.timeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
        const result = await new Promise<MoveResult>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          // Settle exactly once: clearing the timer on either outcome so a
          // terminal status can't leave a timer that later double-fails, and a
          // timeout/failed status always rolls back the overlay via the reconciler.
          const resolver: PendingResolver = {
            resolve: (evt) => {
              if (timer) clearTimeout(timer);
              resolve({ bundleId, calldata, system, status: evt.status, txHash: evt.txHash });
            },
            reject: (err) => {
              if (timer) clearTimeout(timer);
              reject(err);
            },
          };
          manager.trackPending(bundleId, resolver);

          const transport = config.transport;
          if (transport.submit) {
            transport.submit({ calldata, bundleId, meta: { system, roomId } }).catch((e) => {
              manager.applyStatus({
                bundleId,
                status: "failed",
                code: "RELAYER_FAILED",
                reason: e instanceof Error ? e.message : "submit failed",
              });
            });
          } else {
            // No transport.submit: nothing will ever ack this bundle. Fail it
            // immediately so the optimistic overlay is rolled back and the
            // promise rejects instead of hanging forever.
            manager.applyStatus({
              bundleId,
              status: "failed",
              code: "RELAYER_FAILED",
              reason: "transport has no submit(): cannot send move",
            });
            return;
          }

          // Safety net: any bundle that never receives a terminal status is
          // auto-failed after timeoutMs (rollback overlay + reject).
          if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
            timer = setTimeout(() => {
              manager.applyStatus({
                bundleId,
                status: "failed",
                code: "RELAYER_FAILED",
                reason: `move timed out after ${timeoutMs}ms with no terminal status`,
              });
            }, timeoutMs);
          }
        });
        return result;
      } catch (e) {
        // Build/submit-time failure: roll back overlay immediately.
        manager.store.removeOverlays(bundleId);
        const err =
          e instanceof NexusError ? e : new NexusError("INTERNAL", "move failed", { cause: e });
        setLastError(err);
        throw err;
      } finally {
        setPending((p) => p.filter((x) => x.bundleId !== bundleId));
      }
    },
    [config, manager, session],
  );

  return {
    move,
    isPending: pending.length > 0,
    pending,
    lastError,
  };
}

function chainId(chain: string): number {
  return chain === "base" ? 8453 : 84532;
}
