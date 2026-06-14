/**
 * BROWSER ERC-7715 "intuitive permission" grant for the SPEND / PAYMENT leg.
 *
 * This is the sip402 formula adapted for Nexus UNO. Instead of the player blindly
 * signing our opaque raw EIP-712 "Delegation" typed data (the budget delegation in
 * lib/delegations.ts), the player grants a spend authorization through MetaMask's
 * NATIVE permission popup — which renders the USDC token, the per-period cap, the
 * period duration and a human justification. MetaMask owns the UX; we only declare
 * intent.
 *
 * Flow (mirrors /tmp/sip402/apps/demo/app/page.tsx ~345-395):
 *   1. Connect MetaMask, ensure Base Sepolia.
 *   2. createWalletClient(...).extend(erc7715ProviderActions()).
 *   3. requestExecutionPermissions([{ chainId, expiry, to: <relayer/redeemer>,
 *        permission: { type: "erc20-token-periodic", data: { tokenAddress: USDC,
 *        periodAmount, periodDuration, startTime, justification }, isAdjustmentAllowed }}]).
 *   4. Capture grants[0] = { context, from, delegationManager, dependencies } and
 *      hand it to the backend (POST /api/grant) as the player's spend authorization.
 *
 * The granted `to` (delegate / redeemer) is OUR relayer — the same EOA that, on the
 * backend, redeems the granted `context` through the CANONICAL MetaMask
 * DelegationManager to pull the entry fee into the Pot (see lib/erc7715-settle.ts).
 *
 * The funds come from the grant's `from` — the player's MetaMask SMART ACCOUNT
 * (the treasury that MetaMask deploys on first grant). The player's USDC must live
 * at that smart-account address, NOT the bare EOA.
 */
import type { Address, Hex } from "@steamlink/types";
import { createWalletClient, custom, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";
import { USDC_ADDRESS, RELAYER_ADDRESS } from "./constants";

const CHAIN_ID = 84532;

/**
 * The daily USDC spend cap exposed in MetaMask's popup. 1 USDC/day comfortably
 * covers the 0.1 USDC entry fee plus a buffer for replays/retries within the period.
 */
export const GRANT_CAP_USD = "1";
const PERIOD_DURATION_SECONDS = 86400; // 1 day
const EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface Erc7715Grant {
  /** The signed delegation chain (player smart account → relayer), redeemed on the backend. */
  context: Hex;
  /** The granting MetaMask smart account (root delegator) — the funds source. */
  from: Address;
  /** The DelegationManager the chain must be redeemed through (canonical MetaMask manager). */
  delegationManager: Address;
  /** Counterfactual deploy deps for `from` (factory + factoryData), if any. */
  dependencies: { factory: string; factoryData: string }[];
  /** The per-period cap, in human USDC units (for the UI). */
  capUsd: string;
}

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}
function injected(): Eip1193 | null {
  return typeof window !== "undefined"
    ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null)
    : null;
}

/** Ensure the wallet is on Base Sepolia (0x14a34 = 84532), adding it if missing. */
async function ensureBaseSepolia(eth: Eip1193): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  } catch (e) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x14a34",
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          },
        ],
      });
    }
  }
}

/**
 * Drive MetaMask's native ERC-7715 popup to grant an `erc20-token-periodic`
 * spend permission to our relayer (the redeemer), then return the granted
 * permission context so the caller can POST it to /api/grant.
 *
 * Throws if no injected wallet is present (the guest / headless path never calls this).
 */
export async function connectMetaMaskGrant(justification?: string): Promise<{ owner: Address; grant: Erc7715Grant }> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or use a guest wallet).");

  const accs = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const owner = (accs?.[0] ?? "") as Address;
  if (!owner) throw new Error("MetaMask returned no account.");
  if (owner.toLowerCase() === RELAYER_ADDRESS.toLowerCase()) {
    throw new Error("That's the relayer account — switch MetaMask to a different wallet to play.");
  }
  await ensureBaseSepolia(eth);

  const walletClient = createWalletClient({
    account: owner,
    chain: baseSepolia,
    transport: custom(eth),
  }).extend(erc7715ProviderActions());

  const now = Math.floor(Date.now() / 1000);

  // The exact ERC-7715 permission request. MetaMask renders this as the intuitive
  // popup: "<justification>" with the USDC token, the per-day cap and the period.
  const grants = await walletClient.requestExecutionPermissions([
    {
      chainId: CHAIN_ID,
      expiry: now + EXPIRY_SECONDS,
      // The delegate / redeemer: OUR relayer EOA redeems the granted context on the backend.
      to: RELAYER_ADDRESS,
      permission: {
        type: "erc20-token-periodic",
        data: {
          tokenAddress: USDC_ADDRESS,
          periodAmount: parseUnits(GRANT_CAP_USD, 6),
          periodDuration: PERIOD_DURATION_SECONDS,
          startTime: now,
          justification: justification ?? `Spend up to ${GRANT_CAP_USD} USDC/day playing onchain games`,
        },
        isAdjustmentAllowed: true,
      },
    },
  ]);

  const g = grants?.[0];
  if (!g || !g.context) throw new Error("MetaMask returned no permission context");

  const dependencies = Array.isArray(g.dependencies)
    ? g.dependencies
        .filter(
          (d) =>
            typeof (d as { factory?: unknown })?.factory === "string" &&
            typeof (d as { factoryData?: unknown })?.factoryData === "string",
        )
        .map((d) => {
          const dep = d as { factory: string; factoryData: string };
          return { factory: dep.factory, factoryData: dep.factoryData };
        })
    : [];

  return {
    owner,
    grant: {
      context: g.context as Hex,
      from: (g.from ?? owner) as Address,
      delegationManager: (g.delegationManager ?? "0x") as Address,
      dependencies,
      capUsd: GRANT_CAP_USD,
    },
  };
}
