# @steamlink/core

> The Nexus game-engine core: define a game as data + logic, one delegation, gasless moves on Base.

## What it is

Nexus is a fully onchain, turn-based game engine for **Base**. The core idea: a
player signs **one** ERC-7710 delegation when they join a room, and the engine
redeems that single signature for everything after — gasless moves (no wallet
popups) and x402 payments bounded by on-chain spend caps. The wallet is never
re-prompted mid-game.

A game is described as **data** (tables — the onchain state schema) and **logic**
(systems — Solidity source). `@steamlink/core` is the heart of that: it turns a
`defineGame(...)` definition into a deploy manifest and a Solidity tables library
via codegen, compiles the single delegation's two caveat groups into concrete
on-chain caveats, signs it (EIP-712), and builds the redeem/move/charge calldata
the relayer submits.

**Base only.** There is no multi-chain abstraction; the budget token is USDC
(6 decimals).

## Install

```bash
npm install @steamlink/core
```

This pulls in `@steamlink/types` (the shared `NexusError` / error-code surface and
branded `Address`/`Hex` types), which `@steamlink/core` re-exports for convenience.

## Quick start

Declare a tiny game with the real `defineGame`. **Tables** are records of
field-typed columns built from the `t` DSL; **systems** map a system name to its
Solidity source path (logic lives in Solidity, not JS). Then derive the deploy
manifest and Solidity tables library from that one definition.

```ts
import { defineGame, t, buildManifest, generateSolidityTables } from "@steamlink/core";

const game = defineGame({
  name: "tic-tac-toe",
  tables: {
    Board: {
      roomId: t.uint256,
      cells: t.bytes, // packed 3x3 board
      turn: t.address,
    },
    Score: {
      player: t.address,
      wins: t.uint32,
    },
  },
  // systems point at Solidity source — the engine never runs game logic in JS
  systems: {
    PlayMove: "src/systems/PlayMove.sol",
    ClaimWin: "src/systems/ClaimWin.sol",
  },
  economy: {
    entryFee: { amount: "1.00", token: "USDC" },
    pot: { type: "winner-take-all", rake: "0.05" },
  },
});

// Deterministic codegen: same schema → same table/system ids, every time.
const manifest = buildManifest(game);          // JSON the CLI deploys
const solidity = generateSolidityTables(manifest); // committed to src/, compiled by Foundry
```

`defineGame` validates eagerly (name must be lower-kebab/snake; at least one
table; each table needs fields; `pot.rake` must be a fraction in `[0, 1)`), so
misconfiguration fails at call time, and table/system typos fail at compile time.

### Signing the single delegation

```ts
import {
  buildGameplayCaveats,
  buildBudgetCaveats,
  signDelegation,
} from "@steamlink/core";

// `addrs` is a DeploymentAddresses (world, delegationManager, turnManager, usdc,
// and the deployed enforcer addresses). Read these from your deployment.
const caveats = [
  ...buildGameplayCaveats(
    {
      gameplay: {
        allowedSystems: [/* bytes32 system ids */],
        turnBound: true,
        expiresAt: Date.now() + 60 * 60 * 1000,
        maxActions: 200,
      },
      budget: {
        token: "USDC",
        totalCap: "10.00",
        perActionCap: "1.00",
        allowedRecipients: [potAddress],
      },
    },
    addrs,
    roomId,
  ),
  ...buildBudgetCaveats(/* same config */, addrs),
];

const signed = await signDelegation(playerAccount /* viem LocalAccount */, {
  chainId: 8453,
  delegationManager: addrs.delegationManager,
  delegate: relayerAddress, // the redeemer; zero address = any redeemer
  caveats,
  maxRedemptions: 200n,
});
```

The backend then builds an execution and redeems it through the manager:

```ts
import {
  buildMoveExecution,
  encodePermissionContext,
  buildRedeemCalldata,
} from "@steamlink/core";

const execution = buildMoveExecution(addrs, systemId, innerSystemCalldata);
const context = encodePermissionContext(signed);
const calldata = buildRedeemCalldata(context, execution); // → relayer
```

## Key exports

**Schema / `defineGame`**
- `defineGame(def)` — define a game from `{ name, tables, systems, economy? }`; validates eagerly, fully typed.
- `t` — the field-type DSL (`t.address`, `t.bool`, `t.uint`/`uint8…uint256`, `t.int`/`int8`/`int256`, `t.bytes32`, `t.bytes`, `t.string`). Each field carries its Solidity type, ABI type, and mapped TS type.
- Types: `GameDefinition`, `EconomyConfig`, `SystemNames<G>`, `TableNames<G>`, `TableSchema`, `FieldType`, `FieldKind`, `RowOf<S>`, `JsTypeOf<F>`, `TDsl`.

**Codegen**
- `buildManifest(game)` — derive the deterministic `DeployManifest` (table/system ids = `keccak256("nexus.<game>.<kind>.<name>")`) the CLI deploys.
- `resourceId(game, kind, name)` — compute a single table/system id.
- `generateSolidityTables(manifest)` — generate the Solidity tables library (string output, committed and compiled by Foundry).
- `solidityLibraryName(name)` — derive a valid Solidity library identifier from a game name (e.g. `my-game` → `MyGameTables`).
- Types: `DeployManifest`, `ManifestTable`, `ManifestSystem`, `ManifestField`.

**Delegation engine**
- `buildGameplayCaveats(config, addrs, roomId)` — compile the gameplay caveat group (system allowlist, turn-bound, timestamp, limited-calls).
- `buildBudgetCaveats(config, addrs)` — compile the budget caveat group (per-action cap, lifetime cap, recipient allowlist).
- `signDelegation(player, params)` — the player signs **one** EIP-712 delegation (the single signature the whole game hinges on).
- `encodePermissionContext(signed)` — `abi.encode(Delegation)` the manager decodes.
- `encodeExecution(target, value, callData)` — ERC-7579 single-execution packing.
- `buildMoveExecution(addrs, systemId, inner)` — execution calldata for a move (`World.call`).
- `buildChargeExecution(addrs, recipient, amount)` — charge via `USDC.transfer`.
- `buildChargeFromExecution(addrs, from, recipient, amount)` — charge via `USDC.transferFrom` (debits the payer).
- `buildRedeemCalldata(context, execution)` — calldata for `manager.redeemDelegations` (single redemption).
- `usdcToWei(amount)` — convert human USDC (6 decimals) to wei.
- `MANAGER_ABI` — the `redeemDelegations(bytes[],bytes32[],bytes[])` ABI fragment.
- `DELEGATION_TYPES`, `ROOT_AUTHORITY`, `eip712Domain(chainId, manager)`, `EIP712_DOMAIN_NAME`, `EIP712_DOMAIN_VERSION` — EIP-712 primitives.
- Types: `Caveat`, `UnsignedDelegation`, `SignedDelegation`, `GameDelegationConfig`, `DeploymentAddresses`.

**Randomness facade** (design §9)
- `random` — the `random.*` facade: `random.commitReveal`, `random.reveal`, `random.fast`, `random.dice`, `random.commitmentFor`, `random.tiers`.
- `commitRevealCommit(secret, opts)` / `commitRevealReveal(requestId, secret, opts)` — tier-1 (trustless two-tx) calldata builders.
- `fastCalldata(opts)` — tier-2 `fastRandom()` (prevrandao, low-stakes only).
- `commitmentFor(secret)` — `keccak256(abi.encodePacked(secret))`, the commitment a reveal must match.
- `dice(randomWord, sides, count)` — pure mapper; mirrors the contract's rejection sampling bit-for-bit so off-chain previews match on-chain results.
- `RANDOMNESS_COORDINATOR_ABI` — minimal coordinator ABI (`requestCommit`/`reveal`/`fastRandom`).
- Types: `RngTier` (`"vrf" | "commit-reveal" | "fast"`), `RandomnessCall`, `CommitRevealOpts`. The `vrf` tier is a documented seam — present in the types but not wired here (VRF needs a funded subscription).

**Shared error surface** (re-exported from `@steamlink/types`)
- `NexusError` and the `NexusErrorCode` type.

## The single delegation

One ERC-7710 grant per player per room carries **two caveat groups**:

- **gameplay** — which systems the delegation may dispatch to (`systemAllowlist`),
  an optional turn restriction (`turnBound`), an expiry (`timestamp`), and an
  optional redemption cap (`limitedCalls`). This makes gasless moves safe: the
  relayer can only call allowed systems, only on the player's turn, only before
  expiry.
- **budget** — a per-redemption spend cap (`perActionCap`), a lifetime cumulative
  cap (`erc20TransferAmount`), and a recipient allowlist (`allowedRecipients`),
  all in USDC. The relayer can never exceed the per-action spend, the lifetime
  spend, or pay an unapproved recipient. An empty recipient list or a zero
  lifetime cap is rejected — there is no unrestricted spend.

The player signs this once at `joinRoom()`. Every subsequent move and payment is
the engine redeeming that same signature (up to `maxRedemptions`). **No flow
re-prompts the wallet mid-game.**

## Part of Nexus

`@steamlink/core` is the flagship package; the rest of the stack sits behind
TypeScript ports with default implementations, so game code never touches a
concrete provider:

- **@steamlink/react** — React hooks for live game state.
- **@steamlink/server** — x402 endpoint middleware for monetized routes.
- **@steamlink/relayer** — the 1Shot permissionless relayer client (gas paid in stablecoins).
- **@steamlink/secrets** — Lit Protocol wrappers for sealed secret state.
- **@steamlink/cli** — scaffold, deploy, migrate, local devnet.
- **@steamlink/types** — shared branded types and the canonical `NexusError` / error codes.

**Base only.**
