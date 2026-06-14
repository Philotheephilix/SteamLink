/**
 * `NexusProvider` — the root React context provider for the @nexus/react surface.
 * It owns one {@link SubscriptionManager} per provider instance (the transport
 * seam to the gateway's WS/state feed) and exposes config + subscriptions to every
 * child hook (`useTable`, `useTurn`, `useGameActions`, `useCharge`, `usePot`, …).
 * The manager is created lazily and disposed on unmount. This is the binding point
 * between the on-chain-truth feed and the optimistic-UI store.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SubscriptionManager } from "./SubscriptionManager.js";
import { type NexusClientConfig, NexusContext, type NexusContextValue } from "./context.js";

export interface NexusProviderProps {
  config: NexusClientConfig;
  children: ReactNode;
}

/**
 * Root provider. Holds the client config and owns one SubscriptionManager that
 * multiplexes every hook's subscriptions over the configured transport. Created
 * lazily once and disposed on unmount (closing the transport, clearing timers).
 */
export function NexusProvider({ config, children }: NexusProviderProps): ReactNode {
  // One manager per provider instance; created lazily, never recreated on render.
  const ref = useRef<NexusContextValue | null>(null);
  if (ref.current === null || ref.current.config.transport !== config.transport) {
    ref.current = { config, manager: new SubscriptionManager(config.transport) };
  }
  // Keep config reference fresh without rebuilding the manager.
  ref.current.config = config;

  const [value] = useState(ref.current);

  useEffect(() => {
    const v = ref.current;
    return () => {
      v?.manager.dispose();
    };
    // Dispose only on unmount of this provider instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <NexusContext.Provider value={value}>{children}</NexusContext.Provider>;
}
