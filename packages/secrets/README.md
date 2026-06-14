# @steamlink/secrets

> Sealed secret game state — hidden hands, fog-of-war — for Nexus.

## What it is

`@steamlink/secrets` is the **sealed secret state** layer for Nexus. It lets a game
keep parts of its state hidden — a player's hand, a fogged map, a face-down
deck — and reveal them only to callers who satisfy on-chain access conditions.

`seal` / `reveal` / `verify` all sit behind a single swappable **Port** (the
`SecretsAdapter` interface), so game code never touches a concrete provider. Two
adapters ship in the box:

- **`LocalSecrets`** — a *real-crypto* default for dev and tests. Genuine
  AES-256-GCM authenticated encryption (`node:crypto`) and genuine secp256k1
  attestation signatures (viem). No network, no credentials.
- **`LitSecrets`** — the production adapter backed by **Lit Protocol** threshold
  encryption: the symmetric key is split across the Lit network and only released
  when the access conditions are met. Decentralized access control, no single
  custodian of the key.

Reveal is **owner-gated** by on-chain `AccessCondition`s — e.g. "only the address
that `ownerOf` this hand may decrypt" — and `verify` can prove a move is legal
**without** revealing the rest of the hand, returning a signed attestation the
on-chain verifier checks.

## Install

```bash
npm install @steamlink/secrets
```

`LocalSecrets` works with **zero extra dependencies** — it is the right choice for
local dev and unit tests.

The `LitSecrets` (production) adapter needs the Lit Protocol packages, declared as
optional peer dependencies. Install them only if you use the Lit path:

```bash
npm install @lit-protocol/lit-node-client @lit-protocol/encryption @lit-protocol/constants
```

## Key exports

Adapters:

- **`LocalSecrets`** — real AES-256-GCM `SecretsAdapter` for dev/test (`LocalSecretsOptions`, `ConditionPredicate`, `defaultConditionPredicate`).
- **`LitSecrets`** — Lit Protocol threshold-encryption `SecretsAdapter` for production (`LitSecretsOptions`).

The Port and shared types:

- **`SecretsAdapter`** — the swappable boundary: `seal`, `reveal`, `verify`.
- **`Sealed`** — a sealed blob (ciphertext + on-chain `commitment` + its conditions).
- **`AccessCondition`** — a single Base-only access-control clause.
- **`AuthContext`**, **`MoveClaim`**, **`Attestation`**, **`Bytes`**, **`Comparator`**, **`LitNetwork`**, **`SecretsChain`** — the rest of the shared shapes.

Named-policy helpers (write conditions by name instead of by hand):

- **`BUILTIN_POLICIES`** — `only-owner`, `reveal-after-round-end`, `decrypt-after-payment-confirmed`.
- **`PolicyRegistry`**, **`defaultPolicyRegistry`** — register/expand named policies.
- **`defineAccessCondition`** — typed, validated inline condition.
- **`assertConditionsValid`**, **`toUnifiedAccessControlConditions`**, **`PolicyContext`**, **`PolicyTemplate`**.

Process-default wrappers (delegate to a configured adapter):

- **`setDefaultSecretsAdapter`**, **`seal`**, **`reveal`**, **`verify`**, **`verifyMove`**.

Move-rule + attestation codec (shared with the on-chain verifier):

- **`isLegalMove`**, **`encodeHand`**, **`decodeHand`**, **`decodeCard`**, **`Card`**.
- **`attestationDigest`**, **`encodeAttestationPayload`**, **`decodeAttestationPayload`**, **`AttestationPayloadFields`**.

## Usage

Seal a payload behind an owner access-condition, then reveal it as the owner:

```ts
import { LocalSecrets, type AccessCondition } from "@steamlink/secrets";

const secrets = new LocalSecrets();
const enc = new TextEncoder();
const dec = new TextDecoder();

const player = "0xabc...";
const hand = [{ color: 0, value: 5 }];

// Only the address that ownerOf this hand may decrypt.
const conditions: AccessCondition[] = [
  {
    chain: "base-sepolia",
    method: "ownerOf",
    returns: { comparator: "=", value: ":userAddress" },
  },
];

// seal(bytes, conditions) -> Sealed (real AES-256-GCM ciphertext)
const sealed = await secrets.seal(enc.encode(JSON.stringify(hand)), conditions);

// reveal(sealed, { caller, state }) -> Uint8Array, gated by the conditions.
// The owner check passes because state.ownerOf matches the caller.
const bytes = await secrets.reveal(sealed, {
  caller: player,
  state: { ownerOf: player.toLowerCase() },
});

const revealed = JSON.parse(dec.decode(bytes)); // back to the original hand
```

A caller who is not the owner (no matching `state.ownerOf`) is rejected with a
typed `REVEAL_DENIED` error — the predicate fails closed.

## Local vs Lit

- **`LocalSecrets`** — use for local dev (`nexus serve`) and unit tests. It is real
  authenticated encryption with no network and no Lit credentials, but it holds the
  symmetric key in-process and evaluates conditions with an injected predicate
  against in-process state.
- **`LitSecrets`** — use in production. The key never lives in one place: it is
  split across the Lit threshold network, and the Lit nodes evaluate the access
  conditions against Base directly. No single party can release a secret on its own.

## Part of Nexus

Part of the Nexus onchain turn-based game engine SDK. **Base only.**
