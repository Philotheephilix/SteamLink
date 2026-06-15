// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {CaveatEnforcerBase} from "./CaveatEnforcerBase.sol";
import {ModeCode} from "../delegation/IDelegation.sol";

/**
 * @title LimitedCallsEnforcer
 * @notice Caps the total number of redemptions over a delegation's lifetime.
 *         Stateful: keys the used-count on `(caller, delegationHash)` so two
 *         delegations never interfere AND a direct caller can never inflate the
 *         counter the real DelegationManager reads.
 * @dev    terms = abi.encode(uint256 maxActions)
 *
 *         SECURITY (C1): `beforeHook` is permissionless by interface, so anyone
 *         could call it directly with a victim's (public) `delegationHash`. We
 *         key the counter on `msg.sender` (the caller — the DelegationManager on
 *         the real path) so a griefer's direct calls only touch THEIR OWN
 *         namespace and can never drive a victim's manager-keyed counter to the
 *         cap. The manager always reads/writes its own slot.
 *
 *         The increment lives in `beforeHook`; a reverting downstream execution
 *         rolls the whole redemption (and this increment) back atomically — so
 *         only SUCCESSFUL redemptions consume a call.
 */
contract LimitedCallsEnforcer is CaveatEnforcerBase {
    /// @notice Reverts once the delegation has been redeemed `maxActions` times.
    error ActionLimitReached();

    /// @notice caller (DelegationManager) => delegationHash => redemptions used.
    mapping(address manager => mapping(bytes32 delegationHash => uint256 used)) public callsUsed;

    function beforeHook(
        bytes calldata terms,
        bytes calldata,
        ModeCode,
        bytes calldata,
        bytes32 delegationHash,
        address,
        address
    ) external override {
        uint256 maxActions = abi.decode(terms, (uint256));
        uint256 used = callsUsed[msg.sender][delegationHash];
        if (used >= maxActions) revert ActionLimitReached();
        callsUsed[msg.sender][delegationHash] = used + 1;
    }
}
