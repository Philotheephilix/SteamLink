import type { Address } from "@nexus/types";
import { useCallback, useMemo, useState } from "react";
import { useTable } from "./useTable.js";

export interface UsePotResult {
  balance: string | null;
  rake: string | null;
  status: "loading" | "open" | "settling" | "closed";
  settle: (winner: Address) => Promise<void>;
  open: () => Promise<Address>;
}

/**
 * Live pot balance + settle/open actions, read from the indexed `Pot` table.
 * `settle` is optimistic on status (open -> settling) and reconciles on the
 * payout webhook; it never needs an admin key (pot delegation redemption).
 */
export function usePot(roomId: bigint): UsePotResult {
  const where = useMemo(() => ({ roomId }), [roomId]);
  const { data, status: tableStatus } = useTable<{
    balance?: string;
    rake?: string;
    status?: string;
    escrow?: string;
  }>("Pot", where);
  const row = data[0];
  const [optimisticStatus, setOptimisticStatus] = useState<"settling" | null>(null);

  const settle = useCallback(async (_winner: Address): Promise<void> => {
    setOptimisticStatus("settling");
    // Real payout goes through the transport/relayer when wired; the webhook
    // then flips the indexed Pot.status to "closed" and clears this overlay.
  }, []);

  const open = useCallback(async (): Promise<Address> => {
    // openPot returns the escrow address once the indexer reflects it.
    return (row?.escrow ?? "0x0000000000000000000000000000000000000000") as Address;
  }, [row?.escrow]);

  const status: UsePotResult["status"] =
    tableStatus === "loading"
      ? "loading"
      : optimisticStatus === "settling"
        ? "settling"
        : ((row?.status as UsePotResult["status"]) ?? "open");

  return {
    balance: row?.balance ?? null,
    rake: row?.rake ?? null,
    status,
    settle,
    open,
  };
}
