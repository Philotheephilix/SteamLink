# Security model & audit status — packages/contracts

> Read this before reviewing any Solidity here. It is the threat model, the
> pre-mainnet audit findings, and exactly how each was fixed and which test proves
> it. Parent map: [`../../AGENTS.md`](../../AGENTS.md).

## Threat model in one paragraph

A player signs **one** EIP-712 delegation (gameplay ⊕ budget caveats) when joining
a room. A funded **relayer** redeems that single signature repeatedly: gasless
moves and real `USDC.transferFrom` charges. The relayer is gas-payer and operator
but is **not** trusted with the player's funds beyond the signed caveats — the
on-chain **caveat enforcers are the only thing bounding how much the relayer can
move and which calls it can make.** The `NexusDelegationManager` is also the
World's **trusted forwarder**, so it asserts player identity (ERC-2771 trailing
sender). Real USDC is escrowed in `Pot` and paid to the winner. Randomness must be
unmanipulable for the money path.

## Trust boundaries

- **Browser** holds only the player's signer. Never the relayer key, Lit
  credentials, or the Pot authority. Browser-safe signing: `web/lib/<game>/delegations.ts`.
- **Backend** holds the funded relayer key (server-only `config.ts`).
- **On-chain** is the source of truth: signatures, caveats, spend caps, turn order,
  and settlement are all enforced in Solidity; the backend cannot exceed them.

## Verification

`forge test` → **108 tests pass** (`FOUNDRY_PROFILE=ci forge test` runs 1000 fuzz
runs). The live zero-mock anvil suite (`scripts/live/local-integration.ts`)
exercises the full redemption + caveat-rejection + charge path against real
deployed contracts. CI (`.github/workflows/ci.yml`) runs both, green on `main`.

## Pre-mainnet audit — findings & fixes

A four-track audit (delegation manager · enforcers · Pot/randomness ·
World/System/TurnManager) was run before the mainnet cutover. All findings are
remediated. **The mainnet deploy is still gated** on the two residual-trust items
noted at the bottom.

### Critical

| ID | Finding | Fix | Where | Test |
|---|---|---|---|---|
| **C1** | Stateful enforcer `beforeHook` is permissionless and trusted the caller-supplied `delegationHash` → anyone could inflate a victim's counters and permanently brick a paid session. | State re-keyed on `(msg.sender, delegationHash)`, so a direct griefer only pollutes their own namespace; the manager always reads its own slot. | `enforcers/LimitedCallsEnforcer.sol`, `enforcers/ERC20TransferAmountEnforcer.sol` | `Enforcers.t.sol:test_LimitedCalls_GrieferCannotDoSManagerCounter`, `BudgetEnforcers.t.sol:test_ERC20TransferAmount_GrieferCannotDoSManagerSpend` |
| **C2** | `Pot.settle` let a single authority name any depositor as winner and drain instantly; no refund path (funds could lock forever); push payout could be bricked by a blocklisted winner. | Two-step **timelocked** settlement (`proposeWinner` → `executeSettle` after `settleDelayBlocks`); a separate **guardian** can `setPaused`/`cancelProposal`; **pull payments** (`owed`/`withdraw`); a **`refund()` timeout**. | `Pot.sol` | `Pot.t.sol` (timelock, guardian pause/cancel, refund, pull-payment) |
| **C3** | Money-bearing randomness used `blockhash`/`prevrandao` (grindable — the committer learns the result before revealing and can abort to re-roll); VRF is unimplemented. | Producers (`requestCommit`, `fastRandom`) gated to **authorized** callers (the relayer/backend, not players) so a player can't grind; VRF documented as the production money path. | `randomness/RandomnessCoordinator.sol` | `Randomness.t.sol:test_RequestCommit_Unauthorized_Reverts`, `test_FastRandom_Unauthorized_Reverts` |

### High

| ID | Finding | Fix | Where |
|---|---|---|---|
| **H1** | Budget enforcers never constrained `transferFrom`'s `from` → a relayer could pull a third party's USDC and charge it to this delegation's cap. | Pin `from == delegator` on every `transferFrom` branch. | `enforcers/{ERC20TransferAmount,PerActionCap,AllowedRecipients}Enforcer.sol` |
| **H3** | Manager was a pure router with no fail-safe — a delegation signed with wrong/empty caveats was a signed spoofing primitive against the trusted-forwarder World. | Deny-by-default: reject `caveats.length == 0` and any zero-address enforcer. | `delegation/NexusDelegationManager.sol` (`NoCaveats`, `ZeroEnforcer`) |
| **H4** | `World.registerSystem` was owner-mutable with no lock → a compromised owner could hot-swap a system mid-game and forge results. | `lockSystem(systemId)` permanently freezes an implementation; `registerSystem` reverts on a locked id. World is `Ownable2Step`. | `world/World.sol` |
| **H5** | `timeout()` was permissionless with no grace → an opponent could steal the turn of a player whose move was a block late; `_rotate` could underflow and brick a room; `turnBlocks=0` allowed instant timeout. | Grace window + **seated-participant** gate on `timeout`; `_rotate` guards an unseated `current`; `turnBlocks > 0` required. | `systems/TurnManager.sol` |

### Medium

- **Expiry boundary** — `TimestampEnforcer` is now **exclusive** (`>=`), closing a sub-second over-grant. `enforcers/TimestampEnforcer.sol`.
- **Fail-closed attribution** — `System._worldAddress()` no longer falls back to `msg.sender` when the router is unwired, so `onlyWorld` rejects everyone until wired. `system/System.sol`.

### Verified sound (no change needed)

Pot reentrancy + CEI ordering; double-settle blocked; deposit accounting; rake
math + `dice` rejection-sampling (no modulo bias); manager increment-before-execute
paired with `nonReentrant` (prevents the maxRedemptions-reentrancy bypass);
enforcers ignore relayer-supplied `args` and read policy only from signed `terms`;
all calldata offsets correct.

## Residual trust — must resolve before mainnet

1. **Pot still *names* the winner** via the settle authority (no on-chain
   game-outcome proof). Deploy `settleAuthority` and `guardian` as **DISTINCT
   multisigs** (the constructor rejects identical zero addresses; choosing two
   independent multisigs is operational). See the `Pot.sol` natspec.
2. **VRF is a documented seam, not wired.** Any payout-affecting roll on mainnet
   should use Chainlink VRF v2.5 via `IRandomnessConsumer`; the commit-reveal/fast
   tiers are for relayer-driven, non-adversarial use.

A professional third-party audit is recommended before custody of real USDC.
