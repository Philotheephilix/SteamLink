import { NexusError } from "@nexus/types";
import type { Address } from "@nexus/types";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useNexus } from "./useNexus.js";

export interface SessionPerms {
  gameplay: {
    allowedSystems: string[];
    turnBound?: boolean;
    expiresAt: number;
    maxActions?: number;
  };
  budget: {
    token: "USDC";
    totalCap: string;
    perActionCap: string;
    allowedRecipients: Address[];
  };
}

export interface Session {
  roomId: bigint;
  account: Address;
  perms: SessionPerms;
  expiresAt: number;
}

export interface UseSessionResult {
  session: Session | null;
  account: Address | null;
  isJoining: boolean;
  join: (roomId: bigint, perms: SessionPerms) => Promise<Session>;
  leave: () => Promise<void>;
  budget: { totalCap: string; spent: string; remaining: string } | null;
  expiresAt: number | null;
  error: NexusError | null;
}

const SCALE = 1_000_000n; // USDC: 6 decimals.
function toWei(s: string): bigint {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [w, f = ""] = body.split(".");
  const v = BigInt(w || "0") * SCALE + BigInt(`${f}000000`.slice(0, 6));
  return neg ? -v : v;
}
function fromWei(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
function sub(a: string, b: string): string {
  return fromWei(toWei(a) - toWei(b));
}
function add(a: string, b: string): string {
  return fromWei(toWei(a) + toWei(b));
}

/**
 * Reactive view of the current room session. The single wallet prompt of the
 * whole UI lives in `join` (one ERC-7715/7710 delegation per room). The budget
 * ledger here is the optimistic source of truth `useCharge` decrements; confirmed
 * charges reconcile against it.
 */
export function useSession(): UseSessionResult {
  const { config, manager } = useNexus();
  const [isJoining, setJoining] = useState(false);
  const [error, setError] = useState<NexusError | null>(null);

  const state = useSyncExternalStore(
    (cb) => manager.session.subscribe(cb),
    () => manager.session.getSnapshot(),
    () => manager.session.getSnapshot(),
  );
  const session = state.session as Session | null;
  const spent = state.spent;

  const account = (session?.account ?? config.signer?.address ?? null) as Address | null;

  const join = useCallback(
    async (roomId: bigint, perms: SessionPerms): Promise<Session> => {
      setError(null);
      setJoining(true);
      try {
        const signer = config.signer;
        if (!signer) {
          const e = new NexusError("NOT_CONNECTED", "no signer configured");
          setError(e);
          throw e;
        }
        const s: Session = {
          roomId,
          account: signer.address as Address,
          perms,
          expiresAt: perms.gameplay.expiresAt,
        };
        manager.session.setSession(s);
        return s;
      } finally {
        setJoining(false);
      }
    },
    [config.signer, manager],
  );

  const leave = useCallback(async (): Promise<void> => {
    manager.session.setSession(null);
  }, [manager]);

  const budget = session
    ? {
        totalCap: session.perms.budget.totalCap,
        spent,
        remaining: sub(session.perms.budget.totalCap, spent),
      }
    : null;

  return {
    session,
    account,
    isJoining,
    join,
    leave,
    budget,
    expiresAt: session?.expiresAt ?? null,
    error,
  };
}

export { sub as subtractAmounts, add as addAmounts };
