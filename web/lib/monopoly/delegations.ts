/**
 * Browser-safe delegation signing. Pure @steamlink/core + viem — no relayer key, no
 * fs. Used by BOTH the browser (the human signs with the guest wallet) and the
 * server-side bots (each bot signs with its own key). The relayer is the delegate
 * (the redeemer); the signer is the delegator (the PLAYER).
 *
 * Mirrors examples/uno/lib/delegations.ts exactly. THIS is the correct pattern:
 * each player signs its OWN gameplay + budget delegation with its OWN key.
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
import { addresses, MONOPOLY_SYSTEM_ID, RELAYER_ADDRESS } from "./deployment";

const CHAIN_ID = 84532;
const GAMEPLAY_MAX_ACTIONS = 400;
const GAMEPLAY_MAX_REDEMPTIONS = 400n;

// Per-delegation salt: timestamp XOR the address prefix makes each signed delegation
// unique (distinct delegation hash) even if the same player signs twice in one ms.
function saltFor(addr: Address): bigint {
  return BigInt(Date.now()) ^ BigInt(`0x${addr.slice(2, 10)}`);
}

/** Sign ONE gameplay delegation that covers all of this player's dice rolls. */
export async function signGameplayDelegation(
  player: LocalAccount,
  roomId: bigint,
  expiresAt = Date.now() + 6 * 3600_000,
): Promise<SignedDelegation> {
  const cfg: GameDelegationConfig = {
    gameplay: {
      allowedSystems: [MONOPOLY_SYSTEM_ID],
      turnBound: true,
      expiresAt,
      maxActions: GAMEPLAY_MAX_ACTIONS,
    },
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

/**
 * Sign ONE budget delegation bounded by caveats for ALL of this player's USDC x402
 * charges this game: the buy-in, every property purchase, and every rent payment.
 * Every charge is a real `transferFrom(player -> Pot, amount)` bounded on-chain by
 * perActionCap/totalCap and the single allowed recipient (the bank/Pot). The Pot
 * pays the accumulated USDC out to the winner on settle.
 */
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
    maxRedemptions: 64n,
  });
}
