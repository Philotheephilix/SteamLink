import { resourceId } from "@nexus/core";
import { type Address, NexusError } from "@nexus/types";
import type { GameModule } from "../types.js";
import type { GameDelegation } from "../types.js";

/** Tunable sanity thresholds (config-driven, safe defaults; fail closed). */
export interface CaveatPolicy {
  /** Max allowed delegation lifetime from now, in ms. Default 24h. */
  maxExpiryMs: number;
  /** Max number of allowed recipients before it is "over-broad". Default 8. */
  maxRecipients: number;
  /** The relayer capability `targetAddress` the delegation `to` must equal. */
  targetAddress: Address;
}

export const DEFAULT_CAVEAT_POLICY: Omit<CaveatPolicy, "targetAddress"> = {
  maxExpiryMs: 24 * 60 * 60 * 1000,
  maxRecipients: 8,
};

/**
 * Server-side caveat-sanity guard (backend spec §8 / phase-05 §4.5). Rejects
 * delegations whose caveats are missing or dangerously broad — the defense that
 * complements the on-chain enforcers. Throws `NexusError("CAVEATS_INVALID")` or
 * `NexusError("TARGET_MISMATCH")`; returns silently when the grant is sane.
 */
export function validateCaveats(
  delegation: GameDelegation,
  game: GameModule,
  policy: CaveatPolicy,
  now: number = Date.now(),
): void {
  const { gameplay, budget } = delegation.caveats;

  // ── target must match relayer capability ──
  if (delegation.to.toLowerCase() !== policy.targetAddress.toLowerCase()) {
    throw new NexusError(
      "TARGET_MISMATCH",
      `delegation to ${delegation.to} != relayer targetAddress ${policy.targetAddress}`,
    );
  }

  // ── expiry: must be present, in the future, and not absurdly far out ──
  if (gameplay.expiresAt === undefined || gameplay.expiresAt === null) {
    throw new NexusError("CAVEATS_INVALID", "gameplay.expiresAt missing — no expiry");
  }
  if (gameplay.expiresAt <= now) {
    throw new NexusError("CAVEATS_INVALID", "gameplay.expiresAt already elapsed");
  }
  if (gameplay.expiresAt - now > policy.maxExpiryMs) {
    throw new NexusError(
      "CAVEATS_INVALID",
      `gameplay.expiresAt too far in the future (> ${policy.maxExpiryMs}ms)`,
    );
  }

  // ── spend cap: a total cap is mandatory and must be > 0 ──
  if (budget.totalCap === undefined || budget.totalCap === null || budget.totalCap === "") {
    throw new NexusError("CAVEATS_INVALID", "budget.totalCap missing — no spend cap");
  }
  if (!(Number(budget.totalCap) > 0)) {
    throw new NexusError("CAVEATS_INVALID", "budget.totalCap must be > 0");
  }
  if (budget.perActionCap === undefined || !(Number(budget.perActionCap) > 0)) {
    throw new NexusError("CAVEATS_INVALID", "budget.perActionCap missing or non-positive");
  }
  if (Number(budget.perActionCap) > Number(budget.totalCap)) {
    throw new NexusError("CAVEATS_INVALID", "budget.perActionCap exceeds budget.totalCap");
  }

  // ── recipients: must be a non-empty, non-over-broad explicit allowlist ──
  if (!budget.allowedRecipients || budget.allowedRecipients.length === 0) {
    throw new NexusError("CAVEATS_INVALID", "budget.allowedRecipients empty — over-broad spend");
  }
  if (budget.allowedRecipients.length > policy.maxRecipients) {
    throw new NexusError(
      "CAVEATS_INVALID",
      `budget.allowedRecipients over-broad (> ${policy.maxRecipients})`,
    );
  }

  // ── system allowlist: every id must be an ACTUAL system of this game (M1) ──
  if (!gameplay.allowedSystems || gameplay.allowedSystems.length === 0) {
    throw new NexusError("CAVEATS_INVALID", "gameplay.allowedSystems empty — over-broad");
  }
  // The canonical bytes32 id set for the game's systems. Membership — not a count
  // — is what gates the delegation: a count check let an attacker substitute an
  // arbitrary system id and still pass.
  const knownSystemIds = new Set(
    Object.keys(game.systems).map((sys) => resourceId(game.name, "system", sys).toLowerCase()),
  );
  for (const id of gameplay.allowedSystems) {
    if (!knownSystemIds.has(String(id).toLowerCase())) {
      throw new NexusError(
        "CAVEATS_INVALID",
        `gameplay.allowedSystems includes unknown system id ${id} (not a system of game "${game.name}")`,
      );
    }
  }
}
