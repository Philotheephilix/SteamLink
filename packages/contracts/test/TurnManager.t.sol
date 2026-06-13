// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";

contract TurnManagerTest is Test {
    TurnManager internal tm;

    address internal a = address(0xA);
    address internal b = address(0xB);
    address internal c = address(0xC);
    address internal reporter = address(0x4E);

    uint64 internal constant TURN_BLOCKS = 10;

    function setUp() public {
        // this test contract is admin (and thus authorized)
        tm = new TurnManager(address(this));
    }

    function _order() internal view returns (address[] memory o) {
        o = new address[](3);
        o[0] = a;
        o[1] = b;
        o[2] = c;
    }

    function test_StartTurns_SeedsCurrentAndDeadline() public {
        tm.startTurns(1, _order(), TURN_BLOCKS);
        assertEq(tm.getCurrent(1), a);
        (, uint64 deadline,, uint16 idx) = tm.getTurn(1);
        assertEq(deadline, uint64(block.number) + TURN_BLOCKS);
        assertEq(idx, 0);
    }

    function test_Advance_RotatesForward() public {
        tm.startTurns(1, _order(), TURN_BLOCKS);
        tm.advance(1);
        assertEq(tm.getCurrent(1), b);
        tm.advance(1);
        assertEq(tm.getCurrent(1), c);
        tm.advance(1);
        assertEq(tm.getCurrent(1), a); // wraps
    }

    function test_Advance_ReverseDirection() public {
        tm.startTurns(1, _order(), TURN_BLOCKS);
        tm.setDirection(1, -1);
        tm.advance(1); // a -> c (reverse wrap)
        assertEq(tm.getCurrent(1), c);
        tm.advance(1); // c -> b
        assertEq(tm.getCurrent(1), b);
    }

    function test_Timeout_BeforeDeadline_Reverts() public {
        tm.startTurns(1, _order(), TURN_BLOCKS);
        vm.expectRevert(abi.encodeWithSelector(TurnManager.TurnManager_DeadlineNotPassed.selector, uint256(1)));
        tm.timeout(1);
    }

    function test_Timeout_AfterDeadline_SkipsWithoutMovingFunds() public {
        tm.startTurns(1, _order(), TURN_BLOCKS);

        // roll past deadline
        vm.roll(block.number + TURN_BLOCKS + 1);

        // permissionless skip: rotates the turn, moves no funds, emits TimedOut.
        vm.expectEmit(true, false, false, true, address(tm));
        emit TurnManager.TurnManager_TimedOut(1, a, reporter);
        vm.prank(reporter);
        tm.timeout(1);

        assertEq(tm.getCurrent(1), b); // skipped a -> b

        // no balance/ETH moved by the contract
        assertEq(address(tm).balance, 0);
    }

    function test_Authorize_Gating() public {
        vm.prank(a);
        vm.expectRevert(TurnManager.TurnManager_NotAuthorized.selector);
        tm.startTurns(1, _order(), TURN_BLOCKS);
    }
}
