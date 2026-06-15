// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {CaveatEnforcerBase} from "./CaveatEnforcerBase.sol";
import {ModeCode} from "../delegation/IDelegation.sol";

/**
 * @title PerActionCapEnforcer
 * @notice Caps the spend of a SINGLE budget redemption (one `charge()`), distinct
 *         from the lifetime cap enforced by the stock ERC20TransferAmountEnforcer.
 *         The execution must be an ERC-20 transfer/transferFrom of the budget
 *         token whose amount does not exceed the per-action cap.
 * @dev    terms = abi.encode(address token, uint256 perActionCap)
 *         The token address is injected from relayer capabilities — never a literal.
 */
contract PerActionCapEnforcer is CaveatEnforcerBase {
    /// @notice Reverts when the single-execution transfer exceeds the per-action cap
    ///         (or the call is not a transfer of the budget token).
    error PerActionCapExceeded();
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
        (address token, uint256 perActionCap) = abi.decode(terms, (address, uint256));
        (address target,, bytes calldata callData) = _decodeExecution(executionCalldata);

        if (target != token) revert PerActionCapExceeded();
        if (callData.length < 4) revert PerActionCapExceeded();

        bytes4 sel = bytes4(callData[0:4]);
        uint256 amount;
        if (sel == TRANSFER_SELECTOR) {
            // transfer(address to, uint256 amount): amount is 2nd arg
            if (callData.length < 4 + 64) revert PerActionCapExceeded();
            amount = uint256(bytes32(callData[36:68]));
        } else if (sel == TRANSFER_FROM_SELECTOR) {
            // transferFrom(address from, address to, uint256 amount): from=1st, amount=3rd
            if (callData.length < 4 + 96) revert PerActionCapExceeded();
            address from = address(uint160(uint256(bytes32(callData[4:36]))));
            if (from != delegator) revert TransferFromNotDelegator();
            amount = uint256(bytes32(callData[68:100]));
        } else {
            revert PerActionCapExceeded();
        }

        if (amount > perActionCap) revert PerActionCapExceeded();
    }
}
