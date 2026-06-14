# @steamlink/types

Shared branded types and the canonical `NexusError` taxonomy for the Nexus SDK.

## What it is

Nexus is a fully onchain, turn-based game engine SDK for Base. `@steamlink/types` is its dependency-free base package: it holds the branded primitive types (addresses, hex, token amounts), the Base chain constants, and the one canonical `NexusError` / error-code taxonomy that every other `@steamlink/*` package imports. Defining errors and primitives once here keeps the whole SDK typed end to end.

## Install

```sh
npm install @steamlink/types
```

```sh
pnpm add @steamlink/types
# or
yarn add @steamlink/types
```

## What's inside

**Branded primitive types** (`branded.ts`) — nominal at compile time, plain strings/bigints at runtime:

- Types: `Hex`, `Address`, `Bytes32`, `TokenAmount`, `TokenSymbol`
- Validators / constructors: `asHex`, `asAddress`, `isAddress`, `asBytes32`, `asTokenAmount`

**Chain constants** (`chain.ts`) — Base only:

- `CHAINS` (config for `base` and `base-sepolia`, including canonical USDC addresses)
- `ChainKey` type, `isChainKey` guard, `chainConfig` lookup

**Errors** (`errors.ts`) — the canonical error surface:

- `NexusError` class with `code`, `retryable`, `context`, `txHash`, plus `toJSON()` and the static guards `NexusError.is` / `NexusError.has`
- `NEXUS_ERROR_CODES` (the full code list) and the `NexusErrorCode` union — e.g. `NOT_YOUR_TURN`, `BUDGET_EXCEEDED`, `DELEGATION_EXPIRED`, `TARGET_MISMATCH`, `PAYMENT_REQUIRED`, `RNG_PENDING`, `INTERNAL`
- `NexusErrorOptions` for constructor options
- `codeFromRevert` — maps an on-chain enforcer revert string to a `NexusErrorCode`

## Usage

Construct and narrow a branded type:

```ts
import { asAddress, type Address } from "@steamlink/types";

const player: Address = asAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
// throws TypeError if the input isn't a 20-byte 0x address
```

Throw and handle a typed error:

```ts
import { NexusError } from "@steamlink/types";

try {
  throw new NexusError("NOT_YOUR_TURN", "It is not your turn to move.");
} catch (e) {
  if (NexusError.has(e, "NOT_YOUR_TURN")) {
    // narrowed to NexusError with code "NOT_YOUR_TURN"
    console.log(e.code, e.retryable);
  }
}
```

## Part of Nexus

Peer packages: `@steamlink/core`, `@steamlink/react`, `@steamlink/server`, `@steamlink/relayer`, `@steamlink/secrets`, `@steamlink/cli`. Base only.
