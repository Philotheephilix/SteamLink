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
