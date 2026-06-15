/**
 * ROLE: the client-side `random.*` facade (design §9, phase-09). Pure, stateless
 * builders that turn a randomness request into calldata for the on-chain
 * `RandomnessCoordinator` (sent via the relayer like any other move) plus the
 * pure `dice` mapper.
 *
 * KEY INVARIANT: every off-chain computation here must mirror the contract
 * bit-for-bit — `commitmentFor` matches the contract's `reveal` check and `dice`
 * replicates the contract's rejection sampling exactly — so the SDK can preview a
 * draw and have it equal the eventual on-chain result. The `vrf` tier is a
 * documented type-level seam only (no oracle wiring; see NOTE on `random`).
 *
 * This module IS the public surface (the `random` const), so it lives in
 * index.ts rather than re-exporting from a sibling.
 */
import type { Hex } from "@nexus/types";
import { encodeFunctionData, encodePacked, keccak256 } from "viem";
import type { CommitRevealOpts, RandomnessCall, RngTier } from "./types.js";

export type { RngTier, RandomnessCall, CommitRevealOpts } from "./types.js";

/**
 * Minimal ABI for the on-chain `RandomnessCoordinator` (phase-09). The facade only
 * needs the three fully-on-chain entrypoints; the future `vrf` tier is a documented
 * seam (see `IRandomnessConsumer` in the contract) and is not wired here.
 */
export const RANDOMNESS_COORDINATOR_ABI = [
  {
    type: "function",
    name: "requestCommit",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ name: "requestId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "reveal",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "secret", type: "bytes32" },
    ],
    outputs: [{ name: "randomWord", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fastRandom",
    inputs: [],
    outputs: [{ name: "randomWord", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * The commitment for a secret: `keccak256(abi.encodePacked(secret))`, matching the
 * contract's `keccak256(abi.encodePacked(secret))` check in `reveal`.
 */
export function commitmentFor(secret: Hex): Hex {
  return keccak256(encodePacked(["bytes32"], [secret]));
}

/**
 * Build the calldata for tier-1 step 1: commit `keccak256(secret)`. The SDK sends
 * this through the relayer; the requester reveals later with `revealCalldata`.
 *
 * @returns the `requestCommit` call AND the commitment (so the caller can persist
 *          the secret off-chain to reveal later).
 */
export function commitRevealCommit(
  secret: Hex,
  opts: CommitRevealOpts,
): RandomnessCall & { commitment: Hex } {
  const commitment = commitmentFor(secret);
  const data = encodeFunctionData({
    abi: RANDOMNESS_COORDINATOR_ABI,
    functionName: "requestCommit",
    args: [commitment],
  });
  return { to: opts.coordinator, data, fn: "requestCommit", tier: "commit-reveal", commitment };
}

/**
 * Build the calldata for tier-1 step 2: reveal `secret` for a prior `requestId`.
 * Must be sent in a LATER block than the commit (the contract enforces this).
 */
export function commitRevealReveal(
  requestId: bigint,
  secret: Hex,
  opts: CommitRevealOpts,
): RandomnessCall {
  const data = encodeFunctionData({
    abi: RANDOMNESS_COORDINATOR_ABI,
    functionName: "reveal",
    args: [requestId, secret],
  });
  return { to: opts.coordinator, data, fn: "reveal", tier: "commit-reveal" };
}

/**
 * Build the calldata for the tier-2 `fast` (prevrandao) single-call draw.
 * LOW-STAKES only — see the tier docs.
 */
export function fastCalldata(opts: CommitRevealOpts): RandomnessCall {
  const data = encodeFunctionData({
    abi: RANDOMNESS_COORDINATOR_ABI,
    functionName: "fastRandom",
    args: [],
  });
  return { to: opts.coordinator, data, fn: "fastRandom", tier: "fast" };
}

/**
 * Map a random word into `count` dice rolls each in `[1, sides]`, mirroring the
 * contract's `dice(...)` rejection sampling EXACTLY so off-chain previews match
 * on-chain results bit-for-bit. Each die consumes `keccak256(word, i)` and rejects
 * the biased tail (`>= floor(2^256/sides)*sides`), re-hashing with a salt until an
 * unbiased draw lands.
 */
export function dice(randomWord: bigint, sides: number, count: number): number[] {
  if (!Number.isInteger(sides) || sides <= 0 || sides > 255) {
    throw new Error(`dice: sides must be an integer in [1,255], got ${sides}`);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 255) {
    throw new Error(`dice: count must be an integer in [1,255], got ${count}`);
  }

  const UINT256_MAX = (1n << 256n) - 1n;
  const sidesBig = BigInt(sides);
  // Largest multiple of `sides` representable; draws at/above are the biased tail.
  const limit = UINT256_MAX - (UINT256_MAX % sidesBig);

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    let draw = BigInt(keccak256(encodePacked(["uint256", "uint256"], [randomWord, BigInt(i)])));
    // On a biased-tail rejection we cannot reuse `draw` (it would loop forever on
    // the same value) nor advance `i` (that would collide with the next die), so
    // we re-hash with an incrementing `salt` — matching the contract's retry.
    let salt = 0n;
    while (draw >= limit) {
      salt += 1n;
      draw = BigInt(
        keccak256(encodePacked(["uint256", "uint256", "uint256"], [randomWord, BigInt(i), salt])),
      );
    }
    rolls.push(Number((draw % sidesBig) + 1n));
  }
  return rolls;
}

/**
 * The `random.*` facade (design §9). Tier-agnostic calldata builders the SDK uses to
 * request randomness through the relayer, plus the pure `dice` mapper.
 *
 * NOTE on the `vrf` tier: it is a documented SEAM (`IRandomnessConsumer` in the
 * contract) — the async oracle wiring is intentionally not implemented because
 * Chainlink VRF v2.5 needs a funded subscription unavailable in CI.
 */
export const random = {
  /** Tier-1 step 1: build the `requestCommit(keccak256(secret))` call. */
  commitReveal: commitRevealCommit,
  /** Tier-1 step 2: build the `reveal(requestId, secret)` call. */
  reveal: commitRevealReveal,
  /** Tier-2: build the `fastRandom()` call (low-stakes prevrandao). */
  fast: fastCalldata,
  /** Pure: map a random word to `count` dice in `[1, sides]` (matches the contract). */
  dice,
  /** Pure: `keccak256(abi.encodePacked(secret))` — the commitment a reveal must match. */
  commitmentFor,
  /** The tiers exposed behind this facade. */
  tiers: ["vrf", "commit-reveal", "fast"] as const satisfies readonly RngTier[],
} as const;
