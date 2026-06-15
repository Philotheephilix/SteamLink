/**
 * Browser-safe delegation signing. Pure @steamlink/core + viem — no relayer key, no
 * fs. Used by BOTH the browser (the human signs with the guest wallet) and the
 * server-side bots/engine (each bot signs with its own key). The relayer is the
 * delegate (the redeemer); the signer is the delegator (the player).
 */
import {
  type GameDelegationConfig,
  type SignedDelegation,
  buildBudgetCaveats,
  buildGameplayCaveats,
  signDelegation,
} from "@steamlink/core";
import type { Address } from "@steamlink/types";
import type { LocalAccount } from "viem/accounts";
import { addresses, RELAYER_ADDRESS } from "./deployment";
import { UNO_ALIAS_SYSTEM_ID } from "./game";

const CHAIN_ID = 84532;
const GAMEPLAY_MAX_ACTIONS = 200;
const GAMEPLAY_MAX_REDEMPTIONS = 200n;

// Per-delegation salt: timestamp XOR the address prefix makes each signed delegation
// unique (distinct delegation hash) even if the same player signs twice in one ms.
function saltFor(addr: Address): bigint {
  return BigInt(Date.now()) ^ BigInt(`0x${addr.slice(2, 10)}`);
}

/** Sign ONE gameplay delegation that covers all of this player's moves this game. */
export async function signGameplayDelegation(
  player: LocalAccount,
  roomId: bigint,
  expiresAt = Date.now() + 6 * 3600_000,
): Promise<SignedDelegation> {
  const cfg: GameDelegationConfig = {
    gameplay: { allowedSystems: [UNO_ALIAS_SYSTEM_ID], turnBound: true, expiresAt, maxActions: GAMEPLAY_MAX_ACTIONS },
    budget: { token: "USDC", totalCap: "0", perActionCap: "0", allowedRecipients: [] },
  };
  return signDelegation(player, {
    chainId: CHAIN_ID,
    delegationManager: addresses.delegationManager,
    delegate: RELAYER_ADDRESS,
    caveats: buildGameplayCaveats(cfg, addresses, roomId),
    salt: saltFor(player.address),
    maxRedemptions: GAMEPLAY_MAX_REDEMPTIONS,
  });
}

/** Sign ONE budget delegation bounded by caveats for the entry-fee x402 charge. */
export async function signBudgetDelegation(
  player: LocalAccount,
  pot: Address,
  perActionCap: string,
  totalCap: string,
  expiresAt = Date.now() + 6 * 3600_000,
): Promise<SignedDelegation> {
  const cfg: GameDelegationConfig = {
    gameplay: { allowedSystems: [], expiresAt },
    budget: { token: "USDC", perActionCap, totalCap, allowedRecipients: [pot] },
  };
  return signDelegation(player, {
    chainId: CHAIN_ID,
    delegationManager: addresses.delegationManager,
    delegate: RELAYER_ADDRESS,
    caveats: buildBudgetCaveats(cfg, addresses),
    salt: saltFor(player.address),
    maxRedemptions: 4n,
  });
}
