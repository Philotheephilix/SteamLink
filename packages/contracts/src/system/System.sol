// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IWorld} from "../world/IWorld.sol";

/**
 * @title System
 * @notice Base contract every Nexus system inherits. Provides the redemption-aware
 *         `_msgSender()` (the seam), `_world()` context, an `onlyWorld` guard, and
 *         typed table read/write helpers that proxy through the World's access
 *         control.
 *
 * @dev    THE REDEMPTION SEAM: `World.call` appends the canonical player as the
 *         trailing 20 bytes of calldata (ERC-2771). `_msgSender()` recovers it.
 *         Systems must NEVER read `msg.sender` directly for player attribution.
 *
 *         ANTI-SPOOFING (Phase 01 §8): trailing-sender bytes are ONLY honored when
 *         the immediate caller is the trusted router (the World). A direct caller
 *         could otherwise append an arbitrary victim address and act as them. When
 *         `msg.sender != trustedRouter` we fall back to `msg.sender`, so a spoofed
 *         tail is ignored. State-mutating entrypoints should additionally gate on
 *         `onlyWorld` so a direct call reverts rather than executing as msg.sender.
 */
abstract contract System {
    /// @notice The World that is permitted to append the canonical sender. Set
    ///         once after deployment (the World is deployed before the system).
    address public trustedRouter;

    error System_RouterAlreadySet();
    error System_NotWorld();

    /// @dev One-time wiring of the trusted router (the World). Reverts if already
    ///      set, so it cannot be re-pointed at an attacker-controlled forwarder.
    function _setTrustedRouter(address router) internal {
        if (trustedRouter != address(0)) revert System_RouterAlreadySet();
        trustedRouter = router;
    }

    /// @notice The true player, resolved through the redemption seam.
    /// @dev Trailing-sender bytes are trusted ONLY when the immediate caller is the
    ///      trusted router (the World). Otherwise the sender is `msg.sender`, which
    ///      neutralizes appended-victim spoofing on the direct path.
    function _msgSender() internal view returns (address sender) {
        if (msg.sender == trustedRouter && trustedRouter != address(0) && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    /// @notice The World that routed this call (always the immediate caller).
    function _world() internal view returns (IWorld) {
        return IWorld(msg.sender);
    }

    modifier onlyWorld() {
        if (msg.sender != _worldAddress()) revert System_NotWorld();
        _;
    }

    /// @dev The address `onlyWorld` checks against — always the configured
    ///      `trustedRouter`. FAIL-CLOSED: there is no msg.sender fallback. Until
    ///      the router is wired (`trustedRouter == address(0)`), `onlyWorld`
    ///      rejects EVERY caller (msg.sender can never equal address(0)), so an
    ///      unwired/partially-deployed system can never be driven directly as a
    ///      spoofable sender. (Audit: System fail-closed.)
    function _worldAddress() internal view virtual returns (address) {
        return trustedRouter;
    }

    // ── typed table helpers — proxy to the World's Store (access-controlled) ──
    function _set(bytes32 tableId, bytes32[] memory key, bytes memory s, bytes memory d) internal {
        IWorld(msg.sender).setRecord(tableId, key, s, d);
    }

    function _get(bytes32 tableId, bytes32[] memory key) internal view returns (bytes memory, bytes memory) {
        return IWorld(msg.sender).getRecord(tableId, key);
    }
}
