import type { DeploymentAddresses } from "@nexus/core";
import type { Address } from "@nexus/types";
import type { ReactNode } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { NexusProvider } from "../src/index.js";
import type { NexusClientConfig } from "../src/index.js";
import type { FakeTransport } from "./fakeTransport.js";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

export const ADDRESSES: DeploymentAddresses = {
  world: addr(1),
  delegationManager: addr(2),
  turnManager: addr(3),
  usdc: addr(4),
  enforcers: {
    turnBound: addr(11),
    systemAllowlist: addr(12),
    timestamp: addr(13),
    limitedCalls: addr(14),
    perActionCap: addr(15),
    erc20TransferAmount: addr(16),
    allowedRecipients: addr(17),
  },
};

// Deterministic local signer (test key — never used on a real chain).
export const SIGNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

export function makeConfig(transport: FakeTransport): NexusClientConfig {
  return {
    chain: "base-sepolia",
    world: ADDRESSES.world,
    addresses: ADDRESSES,
    signer: SIGNER,
    transport,
  };
}

export function wrapper(config: NexusClientConfig) {
  return ({ children }: { children: ReactNode }) => (
    <NexusProvider config={config}>{children}</NexusProvider>
  );
}
