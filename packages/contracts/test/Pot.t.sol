// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Pot} from "../src/Pot.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PotTest is Test {
    MockERC20 internal usdc;
    Pot internal pot;

    address internal settleAuthority = address(0x5E771E);
    address internal rakeCollector = address(0xCAFE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint16 internal constant RAKE_BPS = 200; // 2%

    function setUp() public {
        usdc = new MockERC20();
        pot = new Pot(usdc, settleAuthority, rakeCollector, RAKE_BPS);

        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
    }

    function _deposit(address who, uint256 roomId, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(pot), amount);
        pot.deposit(roomId, amount);
        vm.stopPrank();
    }

    function test_OpenDepositSettle_RakeMath() public {
        uint256 roomId = 1;
        vm.prank(settleAuthority);
        pot.openPot(roomId);
        _deposit(alice, roomId, 5e6);
        _deposit(bob, roomId, 5e6);

        uint256 total = 10e6;
        uint256 expectedRake = (total * RAKE_BPS) / 10_000; // 0.2 USDC
        uint256 expectedPayout = total - expectedRake;

        vm.expectEmit(true, true, false, true, address(pot));
        emit Pot.Pot_Settled(roomId, alice, expectedPayout, expectedRake);
        vm.prank(settleAuthority);
        pot.settle(roomId, alice);

        assertEq(usdc.balanceOf(alice), 100e6 - 5e6 + expectedPayout);
        assertEq(usdc.balanceOf(rakeCollector), expectedRake);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    function test_Settle_OnlyAuthority() public {
        uint256 roomId = 2;
        vm.prank(settleAuthority);
        pot.openPot(roomId);
        _deposit(alice, roomId, 5e6);

        vm.prank(alice);
        vm.expectRevert(Pot.Pot_NotSettleAuthority.selector);
        pot.settle(roomId, alice);
    }

    function test_Deposit_RevertsWhenNotOpen() public {
        vm.startPrank(alice);
        usdc.approve(address(pot), 1e6);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_NotOpen.selector, uint256(3)));
        pot.deposit(3, 1e6);
        vm.stopPrank();
    }

    function test_DoubleSettle_Reverts() public {
        uint256 roomId = 4;
        vm.prank(settleAuthority);
        pot.openPot(roomId);
        _deposit(alice, roomId, 5e6);

        vm.prank(settleAuthority);
        pot.settle(roomId, alice);

        vm.prank(settleAuthority);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_NotOpen.selector, roomId));
        pot.settle(roomId, alice);
    }

    // ── M4: openPot is restricted to the settle authority ──
    function test_OpenPot_OnlySettleAuthority() public {
        vm.prank(alice);
        vm.expectRevert(Pot.Pot_NotSettleAuthority.selector);
        pot.openPot(5);
    }

    // ── M4: settle rejects a winner who never deposited ──
    function test_Settle_RejectsNonParticipantWinner() public {
        uint256 roomId = 6;
        vm.prank(settleAuthority);
        pot.openPot(roomId);
        _deposit(alice, roomId, 5e6);

        // bob never deposited into this room → cannot be the winner
        vm.prank(settleAuthority);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_WinnerNotParticipant.selector, roomId, bob));
        pot.settle(roomId, bob);
    }
}
