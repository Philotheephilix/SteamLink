// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title Nexus minimal ERC-7710 delegation interfaces
 * @notice These are MINIMAL LOCAL interfaces that match the MetaMask Delegation
 *         Framework (ERC-7710) signatures. We define them locally rather than
 *         vendoring the full framework so the package compiles deterministically
 *         and stays Base-only and small. They are *signature-compatible* with the
 *         canonical framework: enforcers written against `ICaveatEnforcer` here
 *         are callable by a framework-style manager.
 *
 * @dev    LIVE INTEGRATION NOTE:
 *         Nexus ships its OWN ERC-7710-style `NexusDelegationManager` (a real
 *         on-chain manager, NOT a mock). These interfaces are signature-compatible
 *         with MetaMask's framework, but Nexus deploys and uses its own manager
 *         with its own EIP-712 domain ("Nexus Game Delegation", version "1").
 *         There is no dependency on a canonical MetaMask deployment at runtime: the
 *         manager address is whatever `NexusDelegationManager` is deployed to and
 *         is wired into the World via `World.setTrustedForwarder(manager)`.
 */

/// @dev ERC-7579 execution mode code. The DelegationManager passes this through
///      to enforcer hooks. We model it as an opaque bytes32 (matches the
///      framework's `ModeCode` user-defined value type wrapping a bytes32).
type ModeCode is bytes32;

/// @notice A single caveat: an enforcer contract plus its encoded terms/args.
/// @dev Matches ERC-7710 `Caveat { address enforcer; bytes terms; bytes args; }`.
struct Caveat {
    address enforcer;
    bytes terms;
    bytes args;
}

/// @notice A signed delegation from `delegator` to `delegate`, gated by caveats.
/// @dev Matches the framework `Delegation` struct field-for-field.
struct Delegation {
    address delegate;
    address delegator;
    bytes32 authority;
    Caveat[] caveats;
    uint256 salt;
    uint256 maxRedemptions;
    bytes signature;
}

/**
 * @notice The caveat-enforcer interface every Nexus enforcer implements.
 * @dev Signatures match the MetaMask Delegation Framework `ICaveatEnforcer`.
 *      The DelegationManager calls `beforeHook` before executing the delegated
 *      action and `afterHook` after. A revert in either aborts the redemption.
 */
interface ICaveatEnforcer {
    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        ModeCode mode,
        bytes calldata executionCalldata,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;

    function afterHook(
        bytes calldata terms,
        bytes calldata args,
        ModeCode mode,
        bytes calldata executionCalldata,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;
}

/**
 * @notice Minimal `DelegationManager` redemption surface (ERC-7710).
 * @dev The canonical MetaMask DelegationManager implements this. The relayer
 *      (Phase 04) calls `redeemDelegations` to redeem a player's delegation; the
 *      manager runs each caveat's `beforeHook`/`afterHook` around the execution.
 */
interface IDelegationManager {
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        ModeCode[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external;
}

// NOTE: The previous `DelegationFramework.DELEGATION_MANAGER` constant (a dead
// address(0) placeholder for a canonical MetaMask deployment) has been REMOVED.
// Nexus deploys its own `NexusDelegationManager`; there is no external canonical
// manager pointer. The live manager address is resolved at deploy time and wired
// into the World via `setTrustedForwarder`.
