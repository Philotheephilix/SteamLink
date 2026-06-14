/**
 * Player signer abstraction.
 *
 * Two backends:
 *   1. METAMASK SMART ACCOUNT (injected EIP-1193 wallet): the player connects
 *      their own MetaMask EOA via a popup, and we derive a MetaMask **Hybrid
 *      DeleGator smart account** owned by that EOA. THAT smart account is the
 *      delegator. Why a smart account and not the raw EOA: MetaMask's
 *      signature-controller blocks `eth_signTypedData` whenever the request has
 *      `primaryType: "Delegation"` AND `message.delegator` is one of the user's
 *      own (internal) MetaMask accounts — "External signature requests cannot
 *      sign delegations for internal accounts." A Hybrid DeleGator has its OWN
 *      contract address (from MetaMask's SimpleFactory), which is NOT an internal
 *      account, so the block does not fire. The owner EOA still signs (a normal
 *      EIP-712 / ECDSA signature, no special MetaMask "delegation" UI), and the
 *      manager — which now verifies via OZ `SignatureChecker.isValidSignatureNow`
 *      — calls the deployed smart account's ERC-1271 `isValidSignature(digest,
 *      sig)`, which `ECDSA.recover(digest, sig) == owner()` validates directly.
 *      The smart account must be DEPLOYED before signing (a one-time SimpleFactory
 *      call — paid by the EOA) so it has code for the ERC-1271 path; a
 *      counterfactual account would yield an ERC-6492-wrapped signature the plain
 *      SignatureChecker can't verify. The player brings their own Base-Sepolia
 *      USDC (held by the SMART ACCOUNT address) + a little ETH for the one-time
 *      deploy + the `approve`.
 *   2. GUEST WALLET (fallback when there is no injected wallet — e.g. the headless
 *      Playwright run): a viem LocalAccount persisted in localStorage so the
 *      session (and the e2e's persistent context) survives reloads.
 *
 * Both expose the SAME shape — a viem account with `address` + `signTypedData`
 * (what @nexus/core's signDelegation uses) plus `ensureApproval()` to grant the
 * delegation manager a USDC allowance. The relayer is the delegate (redeemer);
 * the connected wallet is the delegator (the player).
 */
import type { Address, Hex } from "@nexus/types";
import { type LocalAccount, generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, maxUint256 } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { Implementation, toMetaMaskSmartAccount } from "@metamask/delegation-toolkit";
import { addresses, deployment, RELAYER_ADDRESS } from "./deployment";

const GUEST_KEY_STORAGE = "monopoly.guest.pk";
// An ERC-4337 bundler URL for Base Sepolia. The MetaMask smart account performs
// its one-time deploy + USDC `approve` as a UserOperation (its `execute` is
// onlyEntryPoint — an owner EOA cannot drive it directly). Set this to a Pimlico
// / Alchemy / Infura bundler endpoint for the live MetaMask path. (The guest +
// headless e2e path does NOT use a bundler.)
const BUNDLER_URL = process.env.NEXT_PUBLIC_BASE_SEPOLIA_BUNDLER_RPC ?? "";
// A public Base-Sepolia RPC the browser can use to read allowances + send the one
// `approve` tx (the guest path). MetaMask uses its own RPC via the injected provider.
const BROWSER_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";

const USDC_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export type WalletKind = "metamask" | "guest";

export interface Connection {
  account: LocalAccount;
  kind: WalletKind;
  /** Grant the delegation manager a USDC allowance ≥ `needed` (sends `approve`
   *  only when the current allowance is short). Resolves once allowance suffices. */
  ensureApproval: (needed: bigint) => Promise<void>;
}

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}
function injected(): Eip1193 | null {
  return typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;
}
export function hasInjectedWallet(): boolean {
  return injected() !== null;
}

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BROWSER_RPC) });

async function ensureAllowance(owner: Address, send: (amount: bigint) => Promise<Hex>, needed: bigint): Promise<void> {
  const current = (await publicClient.readContract({
    address: deployment.usdc, abi: USDC_ABI, functionName: "allowance", args: [owner, addresses.delegationManager],
  })) as bigint;
  if (current >= needed) return;
  try {
    const hash = await send(maxUint256);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    throw new Error(
      `Couldn't approve USDC. Use a normal wallet that holds a little Base-Sepolia ETH (for the one approve) — not a smart/relay account. (${m.slice(0, 120)})`,
    );
  }
}

// MetaMask's SimpleFactory deploy ABI (deploy a Hybrid DeleGator at its
// deterministic CREATE2 address). The toolkit hands us the factory address +
// the full factory calldata via `getFactoryArgs()`; we just need a raw `call`.
// A zero deploySalt makes the smart-account address a pure function of the
// owner EOA, so the same EOA always resolves the same smart account (and its
// USDC balance persists across sessions).
const DEPLOY_SALT: Hex = `0x${"00".repeat(32)}`;

/** Ensure the wallet is on Base Sepolia (0x14a34 = 84532), adding it if missing. */
async function ensureBaseSepolia(eth: Eip1193): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  } catch (e) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x14a34", chainName: "Base Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [BROWSER_RPC], blockExplorerUrls: ["https://sepolia.basescan.org"],
        }],
      });
    }
  }
}

/** Connect the injected (MetaMask) wallet via a popup and derive the player's
 *  MetaMask Hybrid smart account (owned by the connected EOA). THAT smart account
 *  is the delegator — see the module header for why the raw EOA can't be.
 *  Throws if no injected wallet is present. */
export async function connectMetaMask(): Promise<Connection> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or use a guest wallet).");
  const accs = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const ownerEoa = (accs?.[0] ?? "") as Address;
  if (!ownerEoa) throw new Error("MetaMask returned no account.");
  // The relayer is the delegate (gas-payer/redeemer); it must NOT be the player.
  if (ownerEoa.toLowerCase() === RELAYER_ADDRESS.toLowerCase()) {
    throw new Error("That's the relayer account — switch MetaMask to a different wallet to play.");
  }
  await ensureBaseSepolia(eth);

  const wallet = createWalletClient({ account: ownerEoa, chain: baseSepolia, transport: custom(eth) });

  // The owner signer: a viem account whose signTypedData/signMessage route to the
  // injected wallet. The toolkit only needs { address, signMessage, signTypedData }.
  const ownerSigner = toAccount({
    address: ownerEoa,
    async signMessage({ message }) { return wallet.signMessage({ account: ownerEoa, message }); },
    async signTypedData(typedData) {
      const args = { ...(typedData as Record<string, unknown>), account: ownerEoa } as Parameters<typeof wallet.signTypedData>[0];
      return wallet.signTypedData(args);
    },
    async signTransaction() { throw new Error("the relayer submits gameplay transactions; the player never signs one"); },
  });

  // Resolve the deterministic Hybrid DeleGator address for this EOA. deployParams
  // for Hybrid = (owner EOA, [] p256 keyIds, [] p256 x, [] p256 y).
  const smartAccount = await toMetaMaskSmartAccount({
    // The toolkit bundles its own viem build; pnpm resolves it to a sibling copy
    // with the same 2.52.2 runtime but a distinct *type* identity (different zod
    // peer), so TS sees "two PublicClients with this name". The runtime is
    // identical — cast across the type boundary.
    client: publicClient as unknown as Parameters<typeof toMetaMaskSmartAccount>[0]["client"],
    implementation: Implementation.Hybrid,
    deployParams: [ownerEoa, [], [], []],
    deploySalt: DEPLOY_SALT,
    signer: { account: ownerSigner as unknown as { address: Address; signMessage: typeof ownerSigner.signMessage; signTypedData: typeof ownerSigner.signTypedData } },
  });
  const smartAddress = smartAccount.address as Address;

  // The delegator account we hand to @nexus/core's signDelegation: its `.address`
  // is the SMART ACCOUNT (so message.delegator is a contract — not an internal
  // MetaMask account — which dodges MetaMask's delegation-signing block, and on
  // chain SignatureChecker takes the ERC-1271 path). Its `.signTypedData` is the
  // OWNER EOA signing directly, yielding a plain 65-byte ECDSA signature that the
  // deployed Hybrid's isValidSignature recovers against owner() with NO wrapping.
  // (We deliberately bypass the toolkit account's own signTypedData, which would
  // ERC-6492-wrap the signature — the plain SignatureChecker can't verify that.)
  const account = toAccount({
    address: smartAddress,
    async signMessage({ message }) { return wallet.signMessage({ account: ownerEoa, message }); },
    async signTypedData(typedData) {
      const args = { ...(typedData as Record<string, unknown>), account: ownerEoa } as Parameters<typeof wallet.signTypedData>[0];
      return wallet.signTypedData(args);
    },
    async signTransaction() { throw new Error("the relayer submits gameplay transactions; the player never signs one"); },
  });

  return {
    account,
    kind: "metamask",
    // Ensure the SMART ACCOUNT (the delegator whose USDC the manager pulls) has
    // approved the manager. Because the Hybrid DeleGator's `execute` is
    // onlyEntryPoint, the approve must go out as an ERC-4337 UserOperation through
    // a bundler — the same UserOp also DEPLOYS the account (viem includes the
    // factory initCode on the first op), giving it code for the ERC-1271 path.
    // The owner EOA signs the UserOp (a PackedUserOperation typed-data — NOT a
    // "Delegation", so MetaMask does not block it). Gas is paid from the smart
    // account's own ETH unless a paymaster is configured.
    ensureApproval: async (needed) => {
      await ensureSmartAccountApproval(smartAccount, smartAddress, needed);
    },
  };
}

/** Approve the delegation manager from the MetaMask smart account via a bundler
 *  UserOp (which also deploys the account on first use). Idempotent: returns
 *  early once the allowance already suffices. Requires NEXT_PUBLIC_BASE_SEPOLIA_BUNDLER_RPC. */
async function ensureSmartAccountApproval(
  smartAccount: Awaited<ReturnType<typeof toMetaMaskSmartAccount>>,
  smartAddress: Address,
  needed: bigint,
): Promise<void> {
  const current = (await publicClient.readContract({
    address: deployment.usdc, abi: USDC_ABI, functionName: "allowance", args: [smartAddress, addresses.delegationManager],
  })) as bigint;
  if (current >= needed) return;

  if (!BUNDLER_URL) {
    throw new Error(
      "MetaMask Smart Account needs an ERC-4337 bundler to approve USDC. Set NEXT_PUBLIC_BASE_SEPOLIA_BUNDLER_RPC to a Base-Sepolia bundler URL (Pimlico/Alchemy/Infura).",
    );
  }
  const approveData = encodeFunctionData({
    abi: USDC_ABI, functionName: "approve", args: [addresses.delegationManager, maxUint256],
  });
  // The Pimlico v2 endpoint is bundler + paymaster + gas oracle in one. `paymaster:
  // true` routes the pm_getPaymasterData calls to the same endpoint so the deploy +
  // approve UserOp is fully SPONSORED — the smart account needs NO ETH (only the
  // USDC entry fee it already holds). Gas is priced via pimlico_getUserOperationGasPrice.
  const bundler = createBundlerClient({
    client: publicClient,
    transport: http(BUNDLER_URL),
    paymaster: true,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const gp = (await bundlerClient.request({
          // @ts-expect-error pimlico-specific method not in viem's union
          method: "pimlico_getUserOperationGasPrice",
        })) as { standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
        return {
          maxFeePerGas: BigInt(gp.standard.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(gp.standard.maxPriorityFeePerGas),
        };
      },
    },
  });
  try {
    const hash = await bundler.sendUserOperation({
      account: smartAccount,
      calls: [{ to: deployment.usdc, data: approveData, value: 0n }],
    });
    await bundler.waitForUserOperationReceipt({ hash });
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    throw new Error(
      `Couldn't approve USDC from your MetaMask Smart Account via the bundler. (${m.slice(0, 160)})`,
    );
  }
}

/** Get-or-create a persistent guest wallet's underlying viem LocalAccount. */
export function getGuestAccount(): LocalAccount {
  let key = typeof window !== "undefined" ? window.localStorage.getItem(GUEST_KEY_STORAGE) : null;
  if (!key) {
    key = generatePrivateKey();
    if (typeof window !== "undefined") window.localStorage.setItem(GUEST_KEY_STORAGE, key);
  }
  return privateKeyToAccount(key as Hex);
}

/** Connect the localStorage-backed guest wallet (no popup). */
export function connectGuest(): Connection {
  const account = getGuestAccount();
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(BROWSER_RPC) });
  return {
    account,
    kind: "guest",
    ensureApproval: (needed) =>
      ensureAllowance(account.address, (amount) =>
        wallet.writeContract({ address: deployment.usdc, abi: USDC_ABI, functionName: "approve", args: [addresses.delegationManager, amount], account, chain: baseSepolia }),
        needed),
  };
}

/** Forget the guest wallet (used by Disconnect so a fresh key is minted next time). */
export function clearGuest(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(GUEST_KEY_STORAGE);
}

export function privyEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
}
