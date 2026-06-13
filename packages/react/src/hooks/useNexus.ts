import { useContext } from "react";
import { NexusContext, type NexusContextValue } from "../provider/context.js";

/**
 * Access the client config + subscription manager from context. Throws a clear
 * error if used outside <NexusProvider>. Other hooks build on this.
 */
export function useNexus(): NexusContextValue {
  const ctx = useContext(NexusContext);
  if (!ctx) {
    throw new Error("useNexus must be used within <NexusProvider>");
  }
  return ctx;
}
