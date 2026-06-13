import { defineGame, resourceId, t } from "@nexus/core";
import type {
  Bundle,
  BundleHandle,
  Eip7702Authorization,
  RelayerAdapter,
  RelayerCapabilities,
  StatusEvent,
  Unsubscribe,
  UpgradeResult,
} from "@nexus/relayer";
import { type Address, type Hex, asAddress } from "@nexus/types";
import type { GameDelegation, SignedDelegation } from "../src/index.js";

export const TARGET = asAddress("0x000000000000000000000000000000000000dEaD");
export const USDC = asAddress("0x0000000000000000000000000000000000005Dc1");
export const PLAYER = asAddress("0x1111111111111111111111111111111111111111");
export const POT = asAddress("0x2222222222222222222222222222222222222222");

/** A small two-table game (uno-ish). First field is the key. */
export const uno = defineGame({
  name: "uno",
  tables: {
    TurnOrder: {
      roomId: t.uint256,
      current: t.address,
      direction: t.uint8,
    },
    Player: {
      id: t.address,
      score: t.uint256,
    },
  },
  systems: { Play: "./Play.sol", Draw: "./Draw.sol" },
  economy: {
    entryFee: { amount: "5", token: "USDC" },
    pot: { type: "winner-take-all", rake: "0.1" },
  },
});

export const TURN_ORDER_TABLE_ID = resourceId("uno", "table", "TurnOrder");

/** A fake signed delegation tuple (shape only; never broadcast in tests). */
export function fakeSigned(): SignedDelegation {
  return {
    delegate: TARGET,
    delegator: PLAYER,
    authority: `0x${"00".repeat(32)}` as Hex,
    caveats: [],
    salt: 0n,
    maxRedemptions: 1n,
    signature: `0x${"ab".repeat(65)}` as Hex,
  };
}

/** A sane GameDelegation that passes caveat validation. */
export function saneDelegation(overrides: Partial<GameDelegation["caveats"]> = {}): GameDelegation {
  return {
    player: PLAYER,
    to: TARGET,
    signed: fakeSigned(),
    caveats: {
      gameplay: {
        allowedSystems: [resourceId("uno", "system", "Play")],
        turnBound: true,
        expiresAt: Date.now() + 60 * 60 * 1000,
        maxActions: 50,
      },
      budget: {
        token: "USDC",
        totalCap: "10",
        perActionCap: "5",
        allowedRecipients: [POT],
      },
      ...overrides,
    },
  };
}

/**
 * A fully in-process fake relayer (DI, not a mock of backend logic). Records
 * submitted bundles and lets the test drive terminal status to resolve awaiting
 * calls via the same `onStatus` contract the real relayer uses.
 */
export class FakeRelayer implements RelayerAdapter {
  readonly bundles: Bundle[] = [];
  private readonly listeners = new Set<(e: StatusEvent) => void>();
  private seq = 0;

  constructor(private readonly caps?: Partial<RelayerCapabilities>) {}

  async getCapabilities(): Promise<RelayerCapabilities> {
    return {
      chains: ["base"],
      tokens: { USDC },
      feeCollector: TARGET,
      targetAddress: TARGET,
      ...this.caps,
    };
  }
  async submitBundle(bundle: Bundle): Promise<BundleHandle> {
    this.bundles.push(bundle);
    return { bundleId: `fake-${++this.seq}` };
  }
  onStatus(cb: (e: StatusEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async upgradeEOA(auth: Eip7702Authorization): Promise<UpgradeResult> {
    return { account: auth.account, txHash: `0x${"00".repeat(32)}` as Hex };
  }
  /** Test helper: emit a terminal status as a 1Shot webhook would. */
  emit(e: StatusEvent): void {
    for (const l of this.listeners) l(e);
  }
}

export function lastBundle(r: FakeRelayer): Bundle {
  const b = r.bundles.at(-1);
  if (!b) throw new Error("no bundle submitted");
  return b;
}

// ── auth signing helpers (C5/H3) ──

import { privateKeyToAccount } from "viem/accounts";
import {
  CALLER_HEADER,
  NONCE_HEADER,
  SIG_HEADER,
  TIMESTAMP_HEADER,
} from "../src/gateway/auth-middleware.js";
import { canonicalMessage } from "../src/gateway/auth.js";

/** A deterministic test signer; its address is the canonical signed-request caller. */
export const SIGNER_PK = `0x${"11".repeat(32)}` as Hex;
export const SIGNER = privateKeyToAccount(SIGNER_PK);
/** The signer's address (use as the session player so move/charge auth matches). */
export const SIGNER_ADDRESS = asAddress(SIGNER.address);

let nonceSeq = 0;

/**
 * Build the signed-request auth headers for a session-scoped call. Signs the
 * SAME canonical payload `verifyRequest` reconstructs (method/path/bodyHash/
 * nonce/timestamp) with the test signer — exercising the real verification path.
 */
export async function authHeaders(
  method: string,
  path: string,
  body: unknown,
  signer = SIGNER,
): Promise<Record<string, string>> {
  const nonce = `n-${++nonceSeq}-${Math.random().toString(16).slice(2)}`;
  const timestamp = Date.now();
  const message = canonicalMessage({ method, path, body, nonce, timestamp });
  const signature = await signer.signMessage({ message });
  return {
    [SIG_HEADER]: signature,
    [NONCE_HEADER]: nonce,
    [TIMESTAMP_HEADER]: String(timestamp),
    [CALLER_HEADER]: signer.address,
  };
}

/** A sane GameDelegation whose player is the given address (defaults to the signer). */
export function saneDelegationFor(
  player: Address = SIGNER_ADDRESS,
  overrides: Partial<GameDelegation["caveats"]> = {},
): GameDelegation {
  const d = saneDelegation(overrides);
  d.player = player;
  return d;
}

/**
 * A fake on-chain receipt reader for the default real facilitator (C6). It
 * reports a chain head far ahead and post-issuance block timestamps so finality
 * checks pass; tests that need a SPECIFIC settlement inject their own receipt.
 */
export function fakeReceiptClient(
  opts: {
    receiptFor?: (hash: Hex) => {
      status: "success" | "reverted";
      blockNumber: bigint;
      logs: readonly { address: Hex; topics: [Hex, ...Hex[]] | Hex[]; data: Hex }[];
    };
  } = {},
) {
  return {
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      if (opts.receiptFor) return opts.receiptFor(hash);
      throw new Error(`no receipt for ${hash}`);
    },
    async getBlockNumber() {
      return 1_000_000n;
    },
    async getBlock() {
      return { timestamp: BigInt(Math.floor((Date.now() + 3_600_000) / 1000)) };
    },
  };
}

export { asAddress };
export type { Address };
