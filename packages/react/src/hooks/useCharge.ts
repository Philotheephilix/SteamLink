import {
  buildBudgetCaveats,
  buildChargeFromExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  signDelegation,
} from "@nexus/core";
import { NexusError } from "@nexus/types";
import type { Address, Hex } from "@nexus/types";
import { useCallback, useState } from "react";
import type { PendingResolver } from "../optimistic/reconcile.js";
import { useNexus } from "./useNexus.js";
import { addAmounts, useSession } from "./useSession.js";

let chargeCounter = 0;
function nextBundleId(): string {
  chargeCounter += 1;
  return `charge-${Date.now().toString(36)}-${chargeCounter}`;
}

/** Default terminal-status timeout for a charge bundle (ms). */
export const DEFAULT_CHARGE_TIMEOUT_MS = 60_000;

export interface ChargeRequest {
  amount: string;
  to: Address;
  reason?: string;
  /**
   * Max time (ms) to await a terminal status before the charge is auto-failed:
   * the optimistic spend decrement is rolled back and the promise rejects, so a
   * lost/never-acked submit can't leave budget stuck or a promise hanging.
   * Default {@link DEFAULT_CHARGE_TIMEOUT_MS} (60s).
   */
  timeoutMs?: number;
}

export interface ChargeResult {
  bundleId: string;
  calldata: Hex;
  txHash?: string;
}

export interface UseChargeResult {
  charge: (req: ChargeRequest) => Promise<ChargeResult>;
  isCharging: boolean;
  remaining: string | null;
  lastError: NexusError | null;
}

/**
 * x402 monetization with budget-aware states. No wallet popup — it redeems the
 * existing session's budget caveats. Optimistically decrements `remaining`; on an
 * enforcer rejection it rolls back and surfaces `BUDGET_EXCEEDED` ("Out of
 * budget") rather than a raw revert.
 */
export function useCharge(): UseChargeResult {
  const { config, manager } = useNexus();
  const { session, budget } = useSession();
  const [isCharging, setCharging] = useState(false);
  const [lastError, setLastError] = useState<NexusError | null>(null);

  const charge = useCallback(
    async (req: ChargeRequest): Promise<ChargeResult> => {
      setLastError(null);
      if (!session) throw new NexusError("SESSION_NOT_FOUND", "join a room first");
      const signer = config.signer;
      if (!signer) throw new NexusError("NOT_CONNECTED", "no signer configured");

      const bundleId = nextBundleId();
      const prevSpent = manager.session.getSnapshot().spent;

      // Optimistic decrement: spent += amount (so remaining drops).
      manager.session.setSpent(addAmounts(prevSpent, req.amount));

      setCharging(true);
      try {
        const caveats = buildBudgetCaveats(
          {
            gameplay: {
              allowedSystems: session.perms.gameplay.allowedSystems as Hex[],
              expiresAt: session.perms.gameplay.expiresAt,
            },
            budget: {
              token: "USDC",
              totalCap: session.perms.budget.totalCap,
              perActionCap: session.perms.budget.perActionCap,
              allowedRecipients: session.perms.budget.allowedRecipients,
            },
          },
          config.addresses,
        );
        const signed = await signDelegation(signer, {
          chainId: config.chain === "base" ? 8453 : 84532,
          delegationManager: config.addresses.delegationManager,
          delegate: signer.address,
          caveats,
        });
        const execution = buildChargeFromExecution(
          config.addresses,
          signer.address as Address,
          req.to,
          req.amount,
        );
        const calldata = buildRedeemCalldata(encodePermissionContext(signed), execution);

        const timeoutMs = req.timeoutMs ?? DEFAULT_CHARGE_TIMEOUT_MS;
        const result = await new Promise<ChargeResult>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const resolver: PendingResolver = {
            resolve: (evt) => {
              if (timer) clearTimeout(timer);
              resolve({ bundleId, calldata, txHash: evt.txHash });
            },
            reject: (err) => {
              if (timer) clearTimeout(timer);
              reject(err);
            },
          };
          manager.trackPending(bundleId, resolver);
          const transport = config.transport;
          if (transport.submit) {
            transport.submit({ calldata, bundleId, meta: { reason: req.reason } }).catch((e) => {
              manager.applyStatus({
                bundleId,
                status: "failed",
                code: "RELAYER_FAILED",
                reason: e instanceof Error ? e.message : "submit failed",
              });
            });
          } else {
            // No transport.submit: nothing will ever ack this bundle. Fail it
            // immediately so the optimistic decrement is rolled back (catch
            // restores prevSpent) and the promise rejects instead of hanging.
            manager.applyStatus({
              bundleId,
              status: "failed",
              code: "RELAYER_FAILED",
              reason: "transport has no submit(): cannot send charge",
            });
            return;
          }

          // Safety net: a never-acked charge is auto-failed after timeoutMs.
          if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
            timer = setTimeout(() => {
              manager.applyStatus({
                bundleId,
                status: "failed",
                code: "RELAYER_FAILED",
                reason: `charge timed out after ${timeoutMs}ms with no terminal status`,
              });
            }, timeoutMs);
          }
        });
        return result;
      } catch (e) {
        // Rollback the optimistic decrement.
        manager.session.setSpent(prevSpent);
        const err =
          e instanceof NexusError ? e : new NexusError("INTERNAL", "charge failed", { cause: e });
        setLastError(err);
        throw err;
      } finally {
        setCharging(false);
      }
    },
    [config, manager, session],
  );

  return { charge, isCharging, remaining: budget?.remaining ?? null, lastError };
}
