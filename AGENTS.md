# AGENTS.md — Navigation map for SteamLink / Nexus

> Canonical map for an AI reviewer or agent. Repo **"SteamLink"**, engine **"Nexus"**.
> Start here, then jump to the file-level pointers below. Companion maps:
> [`web/AGENTS.md`](web/AGENTS.md) (the Next.js mono-app) and
> [`packages/contracts/SECURITY.md`](packages/contracts/SECURITY.md) (on-chain
> security model + audit status — read before reviewing any Solidity).

## System summary

Nexus is a fully on-chain, turn-based game engine for **Base**. A player signs
**one** ERC-7710 / EIP-712 delegation when they join a room; a backend relayer
redeems that single delegation for everything afterward — **gasless moves** (no
wallet popups) and **x402 USDC payments** bounded by on-chain spend caps. Game
state lives in an on-chain ECS World; entry fees + winner payout settle through an
escrow `Pot`. Live and verifiable on **Base Sepolia** today; **mainnet cutover is
gated on the pre-mainnet security review** (see `SECURITY.md`).

## Repository map (current)

A pnpm + turborepo monorepo. **Local package names are `@nexus/*`; they are
published to npm as `@steamlink/*`** (the `web` app imports the published
`@steamlink/*`). Three top-level areas:

| Path | What it is |
|---|---|
| `packages/*` | The SDK + Solidity engine (the reusable product). |
| `web/` | The **Next.js 15 mono-app**: the marketing site, the `/docs` page, and BOTH reference games (UNO + Monopoly) as routes. See [`web/AGENTS.md`](web/AGENTS.md). |
| `scripts/` | Live, zero-mock integration harness (`scripts/live/*`) run against a local anvil + Base Sepolia. |
| `docs/roadmap/` | The 13-phase execution roadmap (`README.md` + `phase-NN-*.md`). |

> **Note:** `examples/*` no longer exists — the reference games were merged into
> the `web/` mono-app (`web/lib/uno`, `web/lib/monopoly`). Any old pointer to
> `examples/uno/...` now maps to `web/lib/uno/...`.

### packages/types — canonical branded types + error surface
- `src/errors.ts` → `NexusError` class + error codes (`NOT_YOUR_TURN`, `BUDGET_EXCEEDED`, `PAYMENT_REQUIRED`, `TARGET_MISMATCH`, …). Imported by every package.
- `src/branded.ts`, `src/chain.ts` → branded `Address`/`Hex`; `chain` is strictly `"base"`.

### packages/core — game definition, codegen, delegation engine
- `src/schema/defineGame.ts` → `defineGame()`: the single source of truth (tables + systems + economy). Eager validation; everything derives from it.
- `src/codegen/{solidity,manifest}.ts` → emit the Solidity table library + deploy manifest so the on-chain World and TS client share one schema.
- `src/delegation/eip712.ts` → the EIP-712 `Delegation` schema; **must match `NexusDelegationManager.sol` byte-for-byte** (there is a live cross-check test in `scripts/live`).
- `src/delegation/engine.ts` → `buildGameplayCaveats` / `buildBudgetCaveats`, `signDelegation` (the one signature), `buildMoveExecution` / `buildChargeFromExecution`, `buildRedeemCalldata`.
- `src/delegation/types.ts` → `SignedDelegation`, `Caveat`, `DeploymentAddresses`.
- `src/randomness/` → randomness facade (commit-reveal / fast tiers).

### packages/contracts — Solidity (Foundry): World, systems, enforcers, escrow
**Security-critical. Read [`SECURITY.md`](packages/contracts/SECURITY.md) first.**
- `src/delegation/NexusDelegationManager.sol` → on-chain ERC-7710 redemption manager: verifies the EIP-712 signature (ECDSA + ERC-1271 via OZ `SignatureChecker`), runs each caveat's before/after hooks, executes the action with the ERC-2771 sender append. **Deny-by-default**: rejects caveat-less / zero-enforcer delegations; enforces `maxRedemptions`.
- `src/delegation/IDelegation.sol` → minimal ERC-7710 interfaces (`ICaveatEnforcer`, `IDelegationManager`), signature-compatible with the MetaMask framework.
- `src/enforcers/*` → the on-chain authorization boundary (the only thing bounding the relayer): `TurnBoundEnforcer`, `SystemAllowlistEnforcer`, `TimestampEnforcer`, `LimitedCallsEnforcer`, `PerActionCapEnforcer`, `ERC20TransferAmountEnforcer` (lifetime cap), `AllowedRecipientsEnforcer`. Stateful enforcers key state on `(caller, delegationHash)` so a direct griefer can't poison the manager's counters (audit C1); budget enforcers pin `transferFrom.from == delegator` (H1).
- `src/world/World.sol` → ECS root: table/system registry + `call` router; **the redemption seam** (resolves the on-behalf-of player from the ERC-2771 trailing bytes only when `msg.sender == trustedForwarder`). `lockSystem()` freezes a system impl (H4).
- `src/system/System.sol` → base for every system; `_msgSender()` recovers the canonical player (fail-closed: never falls back to `msg.sender` when unwired).
- `src/systems/TurnManager.sol` → turn order + AFK `timeout` (grace window + seated-participant gate, H5).
- `src/Pot.sol` → USDC escrow per room. **Hardened (audit C2):** two-step **timelocked** settlement (`proposeWinner` → `executeSettle`), a separate **guardian** (pause + cancel), **pull payments** (`owed`/`withdraw`), and a **`refund()` timeout**.
- `src/randomness/RandomnessCoordinator.sol` → on-chain randomness; producers gated to authorized callers (C3); VRF is a documented seam.
- `test/*.t.sol` → Foundry tests (108, incl. `ManagerHardening`, `SenderSpoofing`, `BudgetEnforcers`, `Pot`, `Randomness`). `test/mocks/*` are fixtures.
- `script/DeployFull.s.sol` → full local/testnet deployment; writes addresses to `deployments/<chainid>.json`.

### packages/relayer — the redemption transport (adapter port)
- `src/port.ts` → `RelayerAdapter` port: **every** redemption reaches chain through this one interface. `Bundle` (+ structured `permissionContext` / `authorizationList`), `RelayerCapabilities`, `StatusEvent`.
- `src/direct.ts` → `DirectRelayer`: self-relay via a funded viem account (devnet/e2e/the live games today).
- `src/oneshot.ts` → `OneShotRelayer`: REST-style 1Shot adapter (HMAC webhook-verified status).
- `src/oneshot-public.ts` → `OneShotPublicRelayer`: the **real 1Shot Permissionless Public Relayer** (JSON-RPC / OpenRPC) — `relayer_getCapabilities` / `getFeeData` / `estimate7710` / `send7710Transaction` / `getStatus`; ERC-7710 delegated bundles, gas paid in a stablecoin. Offline-tested via injected `fetch` (`oneshot-public.test.ts`).

### packages/backend — gateway, rooms/sessions, lifecycles, indexer, pots
- `src/compose/createBackend.ts` → composition root (adapters + RoomService + PotService + webhook).
- `src/gateway/{server,routes}.ts` → stateless Hono app + handlers (join / move / charge / state / subscribe / webhook / healthz).
- `src/rooms/RoomService.ts` → room + session lifecycle; holds the signed delegation. `src/rooms/caveats.ts` → server-side caveat-sanity guard (defense in depth).
- `src/lifecycles/{move,charge,webhook}.ts` → redeem gameplay / budget delegations; verify HMAC + confirm settlement.
- `src/indexer/`, `src/pots/PotService.ts` → indexer seam + escrow settlement.

### packages/server — x402 monetization middleware + facilitator
- `src/monetize.ts` → `createMonetizeHandler`: framework-agnostic x402 gate. `src/adapters/{express,hono}.ts`.
- `src/facilitator/delegation-facilitator.ts` → verifies redemptions on Base (receipt reading, nonce replay protection, finality depth).

### packages/secrets — sealed secret state (Lit Protocol)
- `src/lit.ts` → `LitSecrets` (default, network-gated): `seal` / conditional `reveal` / `verify`. `src/local.ts` → `LocalSecrets` (offline AES-256-GCM for dev/tests). `src/index.ts` → port + policy registry + move-rule codec.

### packages/react — live game-state hooks
- `src/provider/NexusProvider.tsx` → root provider (one `SubscriptionManager`). `src/hooks/*` → `useTable`, `useTurn`, `useGameActions`, `useCharge`, `usePot`, `useSession`. `src/optimistic/*` → optimistic store + reconcile.

### packages/cli — scaffold, codegen, deploy, devnet
- `src/cli.ts` → `nexus` CLI: `init`, `codegen`, `deploy`, `dev`, `migrate`, `fork` (`src/commands/`).

### web/ — the Next.js mono-app (site + docs + both games)
Full map in [`web/AGENTS.md`](web/AGENTS.md). In brief: `app/page.tsx` (landing),
`app/docs/page.tsx` (SDK reference + contribute guide), `app/play/{uno,monopoly}/`
(the games), `app/api/{uno,monopoly}/*` (namespaced route handlers),
`lib/{uno,monopoly}/*` (server-only game engines), `lib/wallet.ts` +
`components/wallet/WalletProvider.tsx` (shared connector), `instrumentation.ts`
(boots both game backends in the Node runtime).

## End-to-end data flow (one signature → gasless moves + x402)

1. **Define / deploy.** A game is a `defineGame(...)` (`packages/core/src/schema/defineGame.ts`); codegen emits the table library; the World/systems/enforcers/Pot are deployed (addresses in `web/lib/<game>/deployments/base-sepolia.json`).
2. **Connect a wallet.** `web/lib/wallet.ts` (`connectMetaMask` = MetaMask Hybrid DeleGator smart account; `connectGuest` = localStorage viem account) via `web/components/wallet/WalletProvider.tsx`.
3. **Sign ONE delegation (gameplay ⊕ budget).** Caveats compiled by `packages/core/src/delegation/engine.ts` (gameplay: turn-bound / system-allowlist / call-limit; budget: per-action + lifetime caps + recipient allowlist), signed once by `signDelegation`. Game-side signing: `web/lib/<game>/delegations.ts`.
4. **Join the room.** The signed delegation is persisted server-side (`packages/backend/src/rooms/RoomService.ts`, after `caveats.ts` validation). **No further wallet prompt.**
5. **Gasless move.** Browser/bot POSTs the gameplay delegation to `web/app/api/<game>/{move,act}/route.ts` → `web/lib/<game>/engine.ts` (`redeemRoll`/`redeemAction`/`redeemMove`), which builds calldata via `packages/core` and submits through the relayer (`packages/relayer` — `DirectRelayer` today, or the `oneshot` rail behind `MONOPOLY_RELAYER`).
6. **On-chain redemption.** `NexusDelegationManager.redeemDelegations` verifies the signature, runs each caveat `beforeHook`, executes into `World.call` with the ERC-2771 player append, runs `afterHook`s. Enforcer rejections surface as typed `NexusError`s.
7. **x402 charge.** POST to `web/app/api/<game>/charge|act/route.ts` → `web/lib/<game>/engine.ts:chargeFromPlayer`, redeeming the **budget** group as `USDC.transferFrom(player → Pot)` (`buildChargeFromExecution`), bounded on-chain by the per-action + lifetime caps + recipient allowlist.
8. **Settlement.** On win, the engine drives the hardened `Pot` (`proposeWinner` → after the timelock `executeSettle` → winner `withdraw`s). See `SECURITY.md` for the trust model.
9. **Status + UI.** Relayer status (webhook or poll) → `StatusEvent` → resolves the pending move/charge; React/UI applies optimistic updates and reconciles on confirmation.

## The two wallet rails (in the games)

- **(a) Custom NexusDelegationManager rail.** Player signs Nexus's raw EIP-712 `Delegation`; redemption verifies via `SignatureChecker` (ECDSA for EOAs, **ERC-1271** for smart accounts). Signing: `web/lib/<game>/delegations.ts`.
- **(b) ERC-7715 intuitive-grant rail.** Player approves a spend through MetaMask's **native** permission popup (`web/lib/<game>/erc7715.ts`, an `erc20-token-periodic` grant); the granted context is redeemed server-side via the **canonical MetaMask DelegationManager** (`web/lib/<game>/erc7715-settle.ts`).

## How to run

```bash
pnpm install
pnpm build            # turbo run build (TS packages + web)
pnpm -r --filter '!@nexus/contracts' test   # vitest
pnpm lint             # biome check (web/ is linted by its own `next lint`)

# Solidity (Foundry) — in packages/contracts
forge build
forge test                       # 108 tests
FOUNDRY_PROFILE=ci forge test    # 1000 fuzz runs (CI profile)

# The mono-app (site + docs + both games)
cd web && pnpm dev    # next dev on :3000  → /, /docs, /play/uno, /play/monopoly

# Live zero-mock integration (spins its own anvil)
pnpm --filter @nexus/scripts exec tsx live/local-integration.ts
```

CI: `.github/workflows/ci.yml` — three jobs (Contracts forge / TS packages / live-anvil), all green on `main`.

## For reviewers — start here

- **Security model + audit status:** [`packages/contracts/SECURITY.md`](packages/contracts/SECURITY.md). The pre-mainnet audit findings (C1–C3, H1–H5, mediums) and exactly how each was fixed + which test proves it. **Read before reviewing any Solidity.**
- **Security-critical code:** `NexusDelegationManager.sol` (sig verification, caveat hook ordering, ERC-2771 append), `src/enforcers/*` (the authorization boundary), `src/system/System.sol:_msgSender` (player attribution), `src/Pot.sol` (custody), `packages/backend/src/rooms/caveats.ts` (server-side defense in depth).
- **Relayer-key boundary:** the funded relayer / signing key lives **only** in the backend (`packages/relayer/src/direct.ts`, `web/lib/<game>/config.ts`, all marked server-only). The browser holds only the player's signer; browser-safe signing is isolated in `web/lib/<game>/delegations.ts`.
- **On-chain invariants:** Base only (`chain === "base"`); one delegation per player per room (no mid-game re-prompt); capabilities are the source of truth (never hardcode tokens; reject `targetAddress` mismatch); webhooks drive the hot path; everything is an adapter; optimistic UI, on-chain truth.
