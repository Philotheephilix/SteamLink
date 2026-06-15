// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICaveatEnforcer, ModeCode} from "../../src/delegation/IDelegation.sol";

/// @dev A no-op caveat enforcer for tests: satisfies the manager's deny-by-default
///      "at least one caveat" rule (H3) without constraining the action, so tests
///      that previously used zero caveats keep their intended behavior.
contract PassEnforcer is ICaveatEnforcer {
    function beforeHook(bytes calldata, bytes calldata, ModeCode, bytes calldata, bytes32, address, address)
        external
        pure
        override
    {}

    function afterHook(bytes calldata, bytes calldata, ModeCode, bytes calldata, bytes32, address, address)
        external
        pure
        override
    {}
}
