import type { DeploymentAddresses } from "@nexus/core";
import type { Address, ChainKey } from "@nexus/types";
import type { LocalAccount } from "viem";
import type { Transport } from "../transport.js";
import type { SubscriptionManager } from "./SubscriptionManager.js";

/**
 * The client config the provider holds. The live backend gateway/indexer isn't
 * built yet, so `transport` is injectable — a real adapter in production, an
 * in-memory fake in tests.
 */
export interface NexusClientConfig {
  chain: ChainKey;
  /** The deployed World address. */
  world: Address;
  /** Deployed delegation manager + enforcer addresses (for building redemptions). */
  addresses: DeploymentAddresses;
  /** The player's signer (smart-account owner). Optional for read-only / SSR. */
  signer?: LocalAccount;
  /** The transport seam to the gateway/indexer/relayer. */
  transport: Transport;
}

/** The value carried by NexusContext. */
export interface NexusContextValue {
  config: NexusClientConfig;
  manager: SubscriptionManager;
}

import { createContext } from "react";

export const NexusContext = createContext<NexusContextValue | null>(null);
