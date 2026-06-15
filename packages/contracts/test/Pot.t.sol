// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Pot} from "../src/Pot.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PotTest is Test {
    MockERC20 internal usdc;
    Pot internal pot;

    address internal settleAuthority = address(0x5E771E);
    address internal guardian = address(0x6A0);
    address internal rakeCollector = address(0xCAFE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCC0);

    uint16 internal constant RAKE_BPS = 200; // 2%
    uint64 internal constant SETTLE_DELAY = 10; // timelock blocks
    uint64 internal constant REFUND_WINDOW = 1000; // refund-after blocks

    function setUp() public {
        usdc = new MockERC20();
        pot = new Pot(usdc, settleAuthority, rakeCollector, RAKE_BPS, guardian, SETTLE_DELAY, REFUND_WINDOW);

        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
    }

    function _open(uint256 roomId) internal {
        vm.prank(settleAuthority);
        pot.openPot(roomId);
    }

    function _deposit(address who, uint256 roomId, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(pot), amount);
        pot.deposit(roomId, amount);
        vm.stopPrank();
    }

    /// @dev propose winner, roll past the timelock, execute (anyone can execute).
    function _settle(uint256 roomId, address winner) internal {
        vm.prank(settleAuthority);
        pot.proposeWinner(roomId, winner);
        vm.roll(block.number + SETTLE_DELAY);
        pot.executeSettle(roomId);
    }

    // ── happy path: timelocked settle + pull-payment withdraw + rake math ──
    function test_SettleTimelocked_PullPayout_RakeMath() public {
        uint256 roomId = 1;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        _deposit(bob, roomId, 5e6);

        uint256 total = 10e6;
        uint256 expectedRake = (total * RAKE_BPS) / 10_000; // 0.2 USDC
        uint256 expectedPayout = total - expectedRake;

        vm.prank(settleAuthority);
        pot.proposeWinner(roomId, alice);
        vm.roll(block.number + SETTLE_DELAY);

        vm.expectEmit(true, true, false, true, address(pot));
        emit Pot.Pot_Settled(roomId, alice, expectedPayout, expectedRake);
        pot.executeSettle(roomId);

        // funds are CREDITED, not pushed — nothing moved until withdraw
        assertEq(usdc.balanceOf(address(pot)), total);
        assertEq(pot.owed(alice), expectedPayout);
        assertEq(pot.owed(rakeCollector), expectedRake);

        vm.prank(alice);
        pot.withdraw();
        vm.prank(rakeCollector);
        pot.withdraw();

        assertEq(usdc.balanceOf(alice), 100e6 - 5e6 + expectedPayout);
        assertEq(usdc.balanceOf(rakeCollector), expectedRake);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    // ── timelock: cannot execute before eta ──
    function test_Execute_BeforeTimelock_Reverts() public {
        uint256 roomId = 2;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        vm.prank(settleAuthority);
        pot.proposeWinner(roomId, alice);
        // no roll → still inside the timelock
        vm.expectRevert(
            abi.encodeWithSelector(Pot.Pot_TimelockNotElapsed.selector, roomId, uint64(block.number) + SETTLE_DELAY)
        );
        pot.executeSettle(roomId);
    }

    // ── only the authority may propose ──
    function test_Propose_OnlyAuthority() public {
        uint256 roomId = 3;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        vm.prank(alice);
        vm.expectRevert(Pot.Pot_NotSettleAuthority.selector);
        pot.proposeWinner(roomId, alice);
    }

    // ── guardian can pause settlement (defense against a compromised authority) ──
    function test_Guardian_Pause_BlocksSettlement() public {
        uint256 roomId = 4;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        vm.prank(settleAuthority);
        pot.proposeWinner(roomId, alice);
        vm.roll(block.number + SETTLE_DELAY);

        vm.prank(guardian);
        pot.setPaused(true);

        vm.expectRevert(Pot.Pot_Paused.selector);
        pot.executeSettle(roomId);
    }

    // ── guardian can cancel a pending (suspicious) proposal during the window ──
    function test_Guardian_CancelProposal() public {
        uint256 roomId = 5;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        vm.prank(settleAuthority);
        pot.proposeWinner(roomId, alice);

        vm.prank(guardian);
        pot.cancelProposal(roomId);

        vm.roll(block.number + SETTLE_DELAY);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_NoProposal.selector, roomId));
        pot.executeSettle(roomId);
    }

    // ── refund timeout: deposits are never permanently locked ──
    function test_Refund_AfterDeadline() public {
        uint256 roomId = 6;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        _deposit(bob, roomId, 3e6);

        // before the deadline, refund is rejected
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_RefundNotYet.selector, roomId, uint64(block.number) + REFUND_WINDOW));
        pot.refund(roomId);

        vm.roll(block.number + REFUND_WINDOW + 1);
        vm.prank(alice);
        pot.refund(roomId);
        vm.prank(bob);
        pot.refund(roomId);

        assertEq(usdc.balanceOf(alice), 100e6); // whole deposit back
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    // ── core guards preserved ──
    function test_Deposit_RevertsWhenNotOpen() public {
        vm.startPrank(alice);
        usdc.approve(address(pot), 1e6);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_NotOpen.selector, uint256(7)));
        pot.deposit(7, 1e6);
        vm.stopPrank();
    }

    function test_DoubleSettle_Reverts() public {
        uint256 roomId = 8;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        _settle(roomId, alice);

        // pot is settled+closed → a second execute reverts
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_NotOpen.selector, roomId));
        pot.executeSettle(roomId);
    }

    function test_OpenPot_OnlySettleAuthority() public {
        vm.prank(alice);
        vm.expectRevert(Pot.Pot_NotSettleAuthority.selector);
        pot.openPot(9);
    }

    function test_Propose_RejectsNonParticipantWinner() public {
        uint256 roomId = 10;
        _open(roomId);
        _deposit(alice, roomId, 5e6);
        vm.prank(settleAuthority);
        vm.expectRevert(abi.encodeWithSelector(Pot.Pot_WinnerNotParticipant.selector, roomId, bob));
        pot.proposeWinner(roomId, bob);
    }

    function test_Withdraw_NothingReverts() public {
        vm.prank(carol);
        vm.expectRevert(Pot.Pot_NothingToWithdraw.selector);
        pot.withdraw();
    }

    function test_SetPaused_OnlyGuardian() public {
        vm.prank(settleAuthority);
        vm.expectRevert(Pot.Pot_NotGuardian.selector);
        pot.setPaused(true);
    }
}
