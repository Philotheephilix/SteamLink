import type { Address } from "@nexus/types";
import { useEffect, useState } from "react";
import type { TurnSnapshot } from "../transport.js";
import { useNexus } from "./useNexus.js";
import { useSession } from "./useSession.js";

export interface UseTurnResult {
  current: Address | null;
  isMyTurn: boolean;
  deadline: number | null;
  secondsLeft: number | null;
  direction: 1 | -1 | null;
  isExpired: boolean;
  status: "loading" | "live" | "degraded";
}

/**
 * Convenience over the room's current turn. Polls the transport's getTurn and
 * derives `isMyTurn` against the session account; runs a local cosmetic countdown
 * from `deadline` (the on-chain TurnBoundEnforcer remains the real arbiter).
 */
export function useTurn(roomId: bigint): UseTurnResult {
  const { config, manager } = useNexus();
  const { account } = useSession();
  const [snap, setSnap] = useState<TurnSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    config.transport
      .getTurn(roomId)
      .then((s) => {
        if (alive) setSnap(s);
      })
      .catch(() => {
        /* leave snap null -> loading */
      });
    return () => {
      alive = false;
    };
  }, [config.transport, roomId]);

  // Local countdown tick (cosmetic). Only runs once a deadline is known.
  useEffect(() => {
    if (!snap?.deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snap?.deadline]);

  const deadline = snap?.deadline ?? null;
  const secondsLeft = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const mgrStatus = manager.status();

  return {
    current: snap?.current ?? null,
    isMyTurn: snap?.current != null && account != null && snap.current === account,
    deadline,
    secondsLeft,
    direction: snap?.direction ?? null,
    isExpired: secondsLeft !== null && secondsLeft <= 0,
    status: snap === null ? "loading" : mgrStatus === "degraded" ? "degraded" : "live",
  };
}
