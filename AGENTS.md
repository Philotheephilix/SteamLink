# AGENTS.md — Navigation map for SteamLink / Nexus

> Canonical map for an AI reviewer. Repo "SteamLink", engine "Nexus".

## System summary

Nexus is a fully on-chain, turn-based game engine for **Base**. A player signs
**one** ERC-7710 / EIP-712 delegation when they join a room; the backend relayer
redeems that single delegation for everything afterward — **gasless moves** (no
wallet popups) and **x402 USDC payments** bounded by on-chain spend caps. Game
state lives in an on-chain ECS World; settlement (entry fees, winner payout) runs
through a trustless `Pot`. The architecture is **mainnet-ready** and is **deployed
and verifiable live on Base Sepolia** (see `examples/*/deployments/`).

## Repository map

A pnpm + turborepo monorepo. `packages/*` is the SDK; `examples/*` are real,
on-chain reference games.

### packages/types — canonical branded types + error surface
- `src/errors.ts` → `NexusError` class + `NEXUS_ERROR_CODES` (e.g. `NOT_YOUR_TURN`, `BUDGET_EXCEEDED`, `PAYMENT_REQUIRED`); `codeFromRevert()` maps on-chain reverts to typed codes. Imported by every package.
- `src/branded.ts`, `src/chain.ts` → branded `Address`/`Hex`/`TokenSymbol`; `chain` is strictly `"base"`.

### packages/core — game definition, codegen, delegation engine
- `src/schema/defineGame.ts` → `defineGame()`: the single source of truth (tables + systems + economy). Eager validation; everything else derives from it.
- `src/codegen/solidity.ts` / `src/codegen/manifest.ts` → emit the `<Game>Tables` Solidity library + deploy manifest so the on-chain World and TS client share one schema.
- `src/delegation/eip712.ts` → the EIP-712 `GameDelegation` schema; **must match `NexusDelegationManager.sol` byte-for-byte**.
- `src/delegation/engine.ts` → `buildGameplayCaveats` / `buildBudgetCaveats`, `signDelegation` (the one signature), `buildMoveExecution` / `buildChargeExecution` / `buildChargeFromExecution`, `buildRedeemCalldata` (`manager.redeemDelegations` calldata).
- `src/randomness/` → randomness facade (commit-reveal / fast tiers).
- `src/index.ts` → package barrel.

### packages/contracts — Solidity (Foundry): World, systems, enforcers, escrow
- `src/world/World.sol` → ECS root: table/system registry + `call` router; **the redemption seam** — when `msg.sender == trustedForwarder` it resolves the on-behalf-of player from the ERC-2771 trailing bytes and appends it to the system calldata.
- `src/world/IWorld.sol` → World interface + canonical `Store_*` events the indexer subscribes to.
- `src/system/System.sol` → base for every system; `_msgSender()` recovers the canonical player from the trailing bytes (systems must never read `msg.sender` for attribution).
- `src/delegation/NexusDelegationManager.sol` → **security-critical.** On-chain ERC-7710 redemption manager: verifies the EIP-712 signed delegation (ECDSA + ERC-1271 via `SignatureChecker`), runs each caveat's before/after hooks, then executes the single delegated action into the target with the ERC-2771 sender append. `redeemDelegations()`.
- `src/delegation/IDelegation.sol` → minimal local ERC-7710 interfaces (`ICaveatEnforcer`, `IDelegationManager`), signature-compatible with the MetaMask framework.
- `src/enforcers/` → caveat enforcers (**security-critical**): `TurnBoundEnforcer.sol` (redeem only on your turn, reads TurnManager), `ERC20TransferAmountEnforcer.sol` (lifetime spend cap), `LimitedCallsEnforcer.sol` (max redemptions). Plus per-action / allowed-recipients / timestamp / system-allowlist enforcers.
- `src/Pot.sol` → trustless USDC escrow per room; `settle()` pays the winner balance − rake; settlement is authority-gated, admin-keyless.
- `src/randomness/RandomnessCoordinator.sol` → fully on-chain randomness: commit-reveal (trustless) + fast/prevrandao (low-stakes); documented VRF seam.
- `test/*.t.sol` → Foundry tests (incl. `NexusDelegationManager.t.sol`, `SenderSpoofing.t.sol`, `ManagerHardening.t.sol`, `BudgetEnforcers.t.sol`). `test/mocks/*` are test fixtures.

### packages/relayer — the redemption transport (adapter port)
- `src/port.ts` → `RelayerAdapter` port: **every** redemption (move or payment) reaches chain through this one interface. `Bundle`, `RelayerCapabilities`, `StatusEvent`.
- `src/direct.ts` → `DirectRelayer`: self-relay via a funded viem account (default for devnet/e2e/examples; this is the relayer EOA redeeming on Base Sepolia).
- `src/oneshot.ts` → `OneShotRelayer`: production 1Shot permissionless relayer (gas in stablecoins, EIP-7702 EOA upgrades, HMAC webhook-verified status).

### packages/backend — gateway, rooms/sessions, lifecycles, indexer, pots
- `src/compose/createBackend.ts` → composition root: wires adapters + RoomService + PotService + awaiting + webhook into a `Backend`.
- `src/gateway/server.ts` / `src/gateway/routes.ts` → stateless Hono app + framework-agnostic handlers (join / move / charge / state / subscribe / webhook / healthz).
- `src/rooms/RoomService.ts` → room lifecycle + sessions; holds the signed delegation for later redemption. `src/rooms/caveats.ts` → server-side caveat-sanity guard (defense in depth complementing on-chain enforcers).
- `src/lifecycles/move.ts` → `handleMove`: redeems the **gameplay** delegation through the relayer. `src/lifecycles/charge.ts` → `handleCharge`: issues a 402, redeems the **budget** delegation as a USDC transfer. `src/lifecycles/webhook.ts` → verifies HMAC, dedupes, confirms charge settlement on-chain, emits `StatusEvent`.
- `src/indexer/` → `InMemoryIndexer` (default) + `nexus-indexer.ts` (documented Postgres/WS seam, phase-06).
- `src/pots/PotService.ts` → smart-account escrow; settles via delegation redemption (no custodial transfer).

### packages/server — x402 monetization middleware + facilitator
- `src/monetize.ts` → `createMonetizeHandler`: framework-agnostic x402 gate (issues 402 challenges, verifies redemptions, maps errors to HTTP status). `src/adapters/{express,hono}.ts` wrap it.
- `src/facilitator/delegation-facilitator.ts` → default facilitator: verifies redemptions on Base via receipt reading, with nonce replay protection + finality depth.

### packages/secrets — sealed secret state (Lit Protocol)
- `src/lit.ts` → `LitSecrets` (default, network-gated): threshold `seal` / conditional `reveal` / TEE `verify`. Credentials live backend-only.
- `src/local.ts` → `LocalSecrets`: offline AES-256-GCM adapter for dev/tests.
- `src/index.ts` → port + adapters + policy registry + move-rule codec.

### packages/react — live game-state hooks
- `src/provider/NexusProvider.tsx` → root provider; owns one `SubscriptionManager` (transport seam to the gateway feed).
- `src/hooks/` → `useTable`, `useTurn`, `useGameActions`, `useCharge`, `usePot`, `useSession`. `src/optimistic/` → optimistic-UI store + reconcile (on-chain truth wins).

### packages/cli — scaffold, codegen, deploy, devnet
- `src/cli.ts` → `nexus` CLI: `init`, `codegen`, `deploy`, `dev`, `migrate`, `fork` (in `src/commands/`).

### examples/uno — on-chain UNO (Next.js), live on Base Sepolia
- `lib/game-backend.ts` → **server-only** authority singleton: holds the live game, seals hands, charges entries, redeems moves, settles the pot. `charge()`, `chargeGrant()`, `move()`, `revealHand()`, `storeGrant()`.
- `lib/engine.ts` → low-level Nexus redemption engine: on-chain randomness, turn setup, `redeemMove`, `chargeEntryFee`, `settlePot`. The relayer EOA is the Pot settle authority.
- `lib/uno-game.ts` → authoritative full-rules UNO state machine.
- `lib/delegations.ts` → browser-safe delegation signing (`signGameplayDelegation`, `signBudgetDelegation`) — pure `@nexus/core` + viem, no relayer key.
- `lib/signer.ts` → wallet abstraction (MetaMask Hybrid DeleGator smart account, or guest localStorage wallet).
- `lib/erc7715.ts` / `lib/erc7715-settle.ts` → the second wallet rail (see below).
- `contracts/UnoGameSystem.sol`, `contracts/UnoPot.sol` → on-chain UNO system + escrow.
- `app/api/{move,charge,grant,start,state,hand,health,new-game}/route.ts` → Next.js route handlers.
- `deployments/base-sepolia.json` → live deployed addresses (delegationManager, world, enforcers, pot, randomness, unoGame, relayer, usdc).

### examples/monopoly — on-chain Monopoly (out of scope for this map)

## End-to-end data flow (one signature → gasless moves + x402)

1. **Define the game.** `examples/uno` is built from a `defineGame(...)` definition (`packages/core/src/schema/defineGame.ts`); `packages/core/src/codegen/solidity.ts` emits the table library and the World/systems are deployed (addresses in `examples/uno/deployments/base-sepolia.json`).

2. **Connect a wallet.** `examples/uno/lib/signer.ts:connectMetaMask` / `connectGuest` yields a signer (a MetaMask Hybrid DeleGator smart account, or a guest viem account).

3. **Sign ONE delegation (gameplay ⊕ budget).** The player signs a single EIP-712 `GameDelegation`. The caveat groups are compiled by `packages/core/src/delegation/engine.ts:buildGameplayCaveats` (turn-bound, system-allowlisted, call-limited) and `buildBudgetCaveats` (per-action + lifetime spend cap, recipient allowlist), and signed by `packages/core/src/delegation/engine.ts:signDelegation` (schema: `packages/core/src/delegation/eip712.ts`). In UNO, `examples/uno/lib/delegations.ts:signGameplayDelegation` / `signBudgetDelegation` drive this.

4. **Join the room.** The signed delegation is persisted server-side: `packages/backend/src/rooms/RoomService.ts:joinRoom`, after `packages/backend/src/rooms/caveats.ts:validateCaveats` rejects over-broad/expired grants. **No further wallet prompt for the rest of the game.**

5. **Gasless move.** Browser/bot POSTs the pre-signed gameplay delegation to `examples/uno/app/api/move/route.ts` → `examples/uno/lib/game-backend.ts:move` (rules-validated) → `examples/uno/lib/engine.ts:redeemMove`. The redemption calldata is built by `packages/core/src/delegation/engine.ts:buildMoveExecution` + `buildRedeemCalldata` and submitted through the relayer (`packages/relayer/src/direct.ts:DirectRelayer.submitBundle`, via the `RelayerAdapter` port). In the SDK backend the equivalent is `packages/backend/src/lifecycles/move.ts:handleMove`.

6. **On-chain redemption.** `packages/contracts/src/delegation/NexusDelegationManager.sol:redeemDelegations` verifies the EIP-712 signature (ECDSA + ERC-1271), runs each caveat's `beforeHook` (`TurnBoundEnforcer`, `LimitedCallsEnforcer`, …), executes the action into `packages/contracts/src/world/World.sol:call` with the ERC-2771 player append, runs `afterHook`s. `World` routes to the system, which recovers the true player via `packages/contracts/src/system/System.sol:_msgSender`. Enforcer rejections surface as typed `NexusError`s (`NOT_YOUR_TURN`, `BUDGET_EXCEEDED`).

7. **x402 charge (entry fee).** Player POSTs to `examples/uno/app/api/charge/route.ts` → `examples/uno/lib/game-backend.ts:charge` → `examples/uno/lib/engine.ts:chargeEntryFee`, redeeming the **budget** caveat group as `USDC.transferFrom(player → Pot)` (`buildChargeFromExecution`), bounded by the on-chain `ERC20TransferAmountEnforcer` cap and recipient allowlist. SDK equivalent: `packages/backend/src/lifecycles/charge.ts:handleCharge` (issues the 402, redeems budget). Verification on the mined webhook: `packages/server/src/facilitator/delegation-facilitator.ts`.

8. **Settlement.** On win, `examples/uno/lib/engine.ts:settlePot` (or `packages/backend/src/pots/PotService.ts:settlePot`) calls `Pot.settle` (`examples/uno/contracts/UnoPot.sol` / `packages/contracts/src/Pot.sol`), paying the winner the pot balance − rake, authority-gated and admin-keyless.

9. **Status + UI.** Relayer status arrives via HMAC-verified webhooks (`packages/backend/src/lifecycles/webhook.ts`) → internal `StatusEvent` → resolves the pending move/charge promise and reconciles the indexer. React hooks (`packages/react/src/hooks/*`) apply optimistic updates and reconcile on the webhook — optimistic UI, on-chain truth.

## The two wallet rails (in the examples)

Both rails redeem a delegation to move USDC; they differ in **which manager**
verifies and **how the player authorizes**.

- **(a) Custom NexusDelegationManager rail.** The player signs Nexus's raw EIP-712
  `GameDelegation`. Redemption goes through `packages/contracts/src/delegation/NexusDelegationManager.sol:redeemDelegations`, which verifies the signature with `SignatureChecker` (ECDSA for EOAs, **ERC-1271** for smart accounts). Signing: `examples/uno/lib/delegations.ts`; gameplay + budget caveats from `packages/core/src/delegation/engine.ts`. This rail carries both gameplay moves and the budget/x402 charge for guest wallets.

- **(b) ERC-7715 intuitive-grant rail.** Instead of signing opaque typed data, the
  player approves a spend through MetaMask's **native** permission popup
  (`examples/uno/lib/erc7715.ts:connectMetaMaskGrant`, an `erc20-token-periodic`
  grant). The granted `context` is POSTed to `examples/uno/app/api/grant/route.ts`
  (`storeGrant`) and later redeemed server-side via the **canonical MetaMask
  DelegationManager** in `examples/uno/lib/erc7715-settle.ts:chargeViaGrant`,
  executing a real `USDC.transferFrom(player → Pot)`. Selected at `/api/charge`
  with `{ grant: true }`.

## How to run

```bash
# Build + test the SDK (from repo root)
pnpm install
pnpm build           # turbo run build
pnpm test            # turbo run test (vitest)
pnpm typecheck

# Solidity (Foundry)
PATH=$HOME/.foundry/bin:$PATH forge test     # in packages/contracts
PATH=$HOME/.foundry/bin:$PATH forge build

# Run an example (UNO), live against Base Sepolia
cd examples/uno
pnpm dev             # next dev on :3100
pnpm bots            # in-process bot players
pnpm test:e2e        # Playwright e2e (verified on Base Sepolia)
pnpm demo            # recorded full-game gameplay video
```

**Deployments** (live, verifiable addresses) live in
`examples/<game>/deployments/base-sepolia.json` (and `84532.json`): World,
NexusDelegationManager, the enforcer set, Pot, RandomnessCoordinator, the game
system, the relayer EOA, and USDC.

## For reviewers

- **Security-critical code.**
  - `packages/contracts/src/delegation/NexusDelegationManager.sol` — signature
    verification (ECDSA + ERC-1271 via `SignatureChecker`), caveat before/after
    hook ordering, and the ERC-2771 sender append. Hardening tests:
    `packages/contracts/test/{NexusDelegationManager,ManagerHardening,SenderSpoofing,MsgSenderResolution}.t.sol`.
  - `packages/contracts/src/enforcers/*` — the on-chain authorization boundary
    (turn gating, per-action + lifetime spend caps, recipient/system allowlists).
    Tests: `test/{Enforcers,BudgetEnforcers}.t.sol`.
  - `packages/contracts/src/system/System.sol:_msgSender` — player attribution;
    systems must never trust raw `msg.sender`.
  - `packages/backend/src/rooms/caveats.ts` — server-side defense in depth before
    a delegation is ever stored.

- **Relayer key boundary.** The relayer / signing key lives **only in the
  backend** — `packages/relayer/src/direct.ts` (funded EOA), the example
  `examples/uno/lib/config.ts` + `lib/engine.ts` + `lib/erc7715-settle.ts` (all
  marked server-only). The browser holds **only** the player's signer; it never
  sees the relayer key, Lit credentials, or the Pot authority. Browser-safe
  signing is isolated in `examples/uno/lib/delegations.ts`.

- **On-chain invariants.**
  - **Base only** — `chain` is strictly `"base"`; no multi-chain abstraction.
  - **One delegation per player per room** — a single EIP-712 grant carries both
    the gameplay and budget caveat groups; no flow re-prompts mid-game.
  - **Capabilities are the source of truth** — payment/fee tokens and the relayer
    `targetAddress` come from `relayer_getCapabilities` and are cached; a
    `targetAddress` mismatch is rejected before a bundle is submitted. Tokens are
    never hardcoded in the hot path.
  - **Webhooks drive the hot path** — status comes from HMAC-verified relayer
    webhooks → internal `StatusEvent`; chain polling is a silent fallback only.
  - **Everything is an adapter** — relayer, secrets, indexer, facilitator,
    randomness each sit behind a TypeScript port with a default impl.
  - **Optimistic UI, on-chain truth** — apply optimistic updates, reconcile on the
    webhook; enforcer rejections surface as typed `NexusError`s.
  - **Pot settlement is admin-keyless** — only the registered settle authority may
    pay out; payout is the pot balance minus rake.
