"use client";

/**
 * App-wide wallet provider + connector — ONE wallet identity shared across the
 * whole site (landing + every game). Wraps the app in the root layout.
 *
 * It owns the connection (a guest LocalAccount or a MetaMask Hybrid smart account,
 * via lib/wallet) and the optional ERC-7715 spend grant (MetaMask's native
 * permission popup, via lib/erc7715). Games consume it with `useWallet()`:
 * identity (`connection.account`) is shared; the per-game spend approval is a
 * call into `connection.ensureApproval(<that game's manager>, amount)`, and the
 * ERC-7715 grant is redeemed against whichever game's pot server-side.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { connectMetaMask, connectGuest, clearGuest, hasInjectedWallet, type Connection } from "@/lib/wallet";
import { connectMetaMaskGrant, type Erc7715Grant } from "@/lib/erc7715";

export type WalletMode = "metamask" | "guest";

interface WalletState {
  connection: Connection | null;
  address: string | null;
  kind: "metamask" | "guest" | null;
  /** The ERC-7715 spend grant captured on a MetaMask connect (null on the guest rail). */
  grant: Erc7715Grant | null;
  connecting: boolean;
  error: string | null;
  /** Connect; `mode` defaults to MetaMask when an injected wallet is present, else guest. */
  connect: (mode?: WalletMode, grantJustification?: string) => Promise<Connection | null>;
  disconnect: () => void;
  copyAddress: () => Promise<void>;
  copied: boolean;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within <WalletProvider>");
  return v;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [grant, setGrant] = useState<Erc7715Grant | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connect = useCallback(async (mode?: WalletMode, grantJustification?: string) => {
    setError(null);
    setConnecting(true);
    try {
      const m = mode ?? (hasInjectedWallet() ? "metamask" : "guest");
      const c = m === "metamask" ? await connectMetaMask() : connectGuest();
      setConnection(c);
      // MetaMask rail: also request the native ERC-7715 spend permission (intuitive popup).
      if (c.kind === "metamask") {
        try {
          const { grant: g } = await connectMetaMaskGrant(grantJustification);
          setGrant(g);
        } catch {
          /* wallet without ERC-7715 — still connected; pay falls back to the approval rail */
        }
      }
      return c;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (connection?.kind === "guest") clearGuest();
    setConnection(null);
    setGrant(null);
    setError(null);
  }, [connection]);

  const copyAddress = useCallback(async () => {
    const a = connection?.account.address;
    if (!a) return;
    try {
      await navigator.clipboard.writeText(a);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  }, [connection]);

  const value = useMemo<WalletState>(
    () => ({
      connection,
      address: connection?.account.address ?? null,
      kind: connection?.kind ?? null,
      grant,
      connecting,
      error,
      connect,
      disconnect,
      copyAddress,
      copied,
    }),
    [connection, grant, connecting, error, connect, disconnect, copyAddress, copied],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
