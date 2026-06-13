import type { RelayerAdapter, RelayerCapabilities } from "@nexus/relayer";
import {
  DelegationFacilitator,
  type FacilitatorAdapter,
  type ReceiptReaderClient,
} from "@nexus/server";
import { type Address, NexusError } from "@nexus/types";
import { InMemoryIndexer } from "../indexer/memory-indexer.js";
import { StubFacilitator } from "../ports/facilitator.js";
import type { IndexerAdapter } from "../ports/indexer.js";
import { MemorySessionStore, type SessionStore } from "../rooms/store.js";

/**
 * Default adapter set (backend spec §2.2 / phase-05 §4.3). The spec names the
 * production defaults `OneShotRelayer`, `LitSecrets`, `ChainlinkVRF`,
 * `NexusIndexer`, `DelegationFacilitator`. In phase-05 the zero-credential,
 * test-faithful defaults are: a caller-provided relayer (no live OneShot account
 * in dev), `InMemoryIndexer`, `StubFacilitator` (Phase-07 swaps in
 * `DelegationFacilitator`), and `MemorySessionStore`. No alternative providers are
 * invented — overrides replace these by passing a different instance.
 */
export function defaultIndexer(): IndexerAdapter {
  return new InMemoryIndexer();
}

export function defaultSessionStore(): SessionStore {
  return new MemorySessionStore();
}

export interface DefaultFacilitatorOptions {
  /** Receipt-reading client for the real on-chain-verifying facilitator (C6). */
  publicClient?: ReceiptReaderClient;
  /**
   * Opt into the UNSAFE dev stub facilitator. Without this (the default) the
   * money-safe path requires a real `publicClient` and builds a
   * `DelegationFacilitator` that confirms settlements on-chain.
   */
  allowUnsafeDev?: boolean;
}

/**
 * The default facilitator (C6). The money-safe default is the REAL
 * `DelegationFacilitator` (on-chain settlement verification) — it requires a
 * `publicClient`. The fabricating `StubFacilitator` is ONLY returned when the
 * caller explicitly opts in via `allowUnsafeDev: true`. If neither a publicClient
 * nor the unsafe flag is provided, construction throws (fail closed).
 */
export function defaultFacilitator(
  capabilities: RelayerCapabilities | (() => Promise<RelayerCapabilities>),
  opts: DefaultFacilitatorOptions = {},
): FacilitatorAdapter {
  if (opts.publicClient) {
    return new DelegationFacilitator({ capabilities, publicClient: opts.publicClient });
  }
  if (opts.allowUnsafeDev) {
    return new StubFacilitator(capabilities, { allowUnsafeDev: true });
  }
  throw new NexusError(
    "INVALID_CONFIG",
    "createBackend: the default facilitator needs a `publicClient` to verify settlements on-chain. " +
      "Pass `publicClient`, supply an explicit `facilitator`, or set `allowUnsafeDevFacilitator: true` for dev only.",
  );
}

/** A relayer is REQUIRED (no zero-config live relayer); the CLI supplies one. */
export function requireRelayer(relayer: RelayerAdapter | undefined): RelayerAdapter {
  if (!relayer) {
    throw new Error(
      "createBackend: a `relayer` adapter is required (DirectRelayer for dev, OneShotRelayer for prod).",
    );
  }
  return relayer;
}

export const DEV_TARGET_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
