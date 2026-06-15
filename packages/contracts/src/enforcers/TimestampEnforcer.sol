// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {CaveatEnforcerBase} from "./CaveatEnforcerBase.sol";
import {ModeCode} from "../delegation/IDelegation.sol";

/**
 * @title TimestampEnforcer
 * @notice Rejects redemption after the delegation's expiry. The design expresses
 *         `expiresAt` in epoch MILLISECONDS (§2.1); EVM works in seconds, so we
 *         convert ms→s here so the rest of the stack speaks one unit.
 * @dev    terms = abi.encode(uint256 expiresAtMs)
 */
contract TimestampEnforcer is CaveatEnforcerBase {
    /// @notice Reverts when block.timestamp is past the delegation expiry.
    error DelegationExpired();

    function beforeHook(
        bytes calldata terms,
        bytes calldata,
        ModeCode,
        bytes calldata,
        bytes32,
        address,
        address
    ) external view override {
        uint256 expiresAtMs = abi.decode(terms, (uint256));
        // The TS engine passes expiry in epoch MILLISECONDS (§2.1); the EVM clock
        // (`block.timestamp`) is in SECONDS. Convert ms->s by integer division,
        // which TRUNCATES toward the earlier second (conservative — never extends
        // the window). Expiry is EXCLUSIVE: redemption is rejected AT the expiry
        // second too (`>=`), closing the sub-second over-grant where `>` left the
        // whole boundary second redeemable past the intended ms expiry.
        uint256 expiresAtSec = expiresAtMs / 1000;
        if (block.timestamp >= expiresAtSec) revert DelegationExpired();
    }
}
