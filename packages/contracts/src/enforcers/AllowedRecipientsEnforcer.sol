// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {CaveatEnforcerBase} from "./CaveatEnforcerBase.sol";
import {ModeCode} from "../delegation/IDelegation.sol";

/**
 * @title AllowedRecipientsEnforcer
 * @notice Restricts the transfer RECIPIENT to an allowlist — the design's
 *         budget.allowedRecipients (pots/sellers). Each execution must be an ERC-20
 *         transfer/transferFrom of the budget token whose `to` recipient is a member
 *         of the allowlist.
 * @dev    terms = abi.encode(address token, address[] allowedRecipients)
 *         The token address is injected from relayer capabilities — never a literal.
 */
contract AllowedRecipientsEnforcer is CaveatEnforcerBase {
    /// @notice Reverts when the transfer recipient is not in the allowlist
    ///         (or the call is not a transfer of the budget token).
    error RecipientNotAllowed();
    /// @notice Reverts when a `transferFrom` would pull from someone other than the delegator.
    error TransferFromNotDelegator();

    bytes4 internal constant TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant TRANSFER_FROM_SELECTOR = 0x23b872dd; // transferFrom(address,address,uint256)

    function beforeHook(
        bytes calldata terms,
        bytes calldata,
        ModeCode,
        bytes calldata executionCalldata,
        bytes32,
        address delegator,
        address
    ) external pure override {
        (address token, address[] memory allowedRecipients) = abi.decode(terms, (address, address[]));
        (address target,, bytes calldata callData) = _decodeExecution(executionCalldata);

        if (target != token) revert RecipientNotAllowed();
        if (callData.length < 4) revert RecipientNotAllowed();

        bytes4 sel = bytes4(callData[0:4]);
        address to;
        if (sel == TRANSFER_SELECTOR) {
            // transfer(address to, uint256 amount): recipient is 1st arg
            if (callData.length < 4 + 64) revert RecipientNotAllowed();
            to = address(uint160(uint256(bytes32(callData[4:36]))));
        } else if (sel == TRANSFER_FROM_SELECTOR) {
            // transferFrom(address from, address to, uint256 amount): from=1st, recipient=2nd
            if (callData.length < 4 + 96) revert RecipientNotAllowed();
            address from = address(uint160(uint256(bytes32(callData[4:36]))));
            if (from != delegator) revert TransferFromNotDelegator();
            to = address(uint160(uint256(bytes32(callData[36:68]))));
        } else {
            revert RecipientNotAllowed();
        }

        for (uint256 i = 0; i < allowedRecipients.length; i++) {
            if (allowedRecipients[i] == to) return;
        }
        revert RecipientNotAllowed();
    }
}
