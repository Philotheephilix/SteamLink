// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ModeCode} from "../src/delegation/IDelegation.sol";
import {TurnBoundEnforcer} from "../src/enforcers/TurnBoundEnforcer.sol";
import {SystemAllowlistEnforcer} from "../src/enforcers/SystemAllowlistEnforcer.sol";
import {TimestampEnforcer} from "../src/enforcers/TimestampEnforcer.sol";
import {LimitedCallsEnforcer} from "../src/enforcers/LimitedCallsEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";

/// @dev Stub exposing ITurnManager.getCurrent for the TurnBoundEnforcer.
contract TurnManagerStub {
    mapping(uint256 => address) public current;

    function setCurrent(uint256 roomId, address who) external {
        current[roomId] = who;
    }

    function getCurrent(uint256 roomId) external view returns (address) {
        return current[roomId];
    }
}

contract EnforcersTest is Test {
    ModeCode internal constant MODE = ModeCode.wrap(bytes32(0));
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // helper: ERC-7579 single-execution calldata = target(20) ++ value(32) ++ callData
    function _exec(address target, uint256 value, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, callData);
    }

    // ── TurnBoundEnforcer ──
    function test_TurnBound_AcceptsCurrentPlayer() public {
        TurnManagerStub tm = new TurnManagerStub();
        tm.setCurrent(1, alice);
        TurnBoundEnforcer e = new TurnBoundEnforcer();
        bytes memory terms = abi.encode(address(tm), uint256(1));
        // should not revert
        e.beforeHook(terms, "", MODE, "", bytes32(0), alice, address(0));
    }

    function test_TurnBound_RejectsNotYourTurn() public {
        TurnManagerStub tm = new TurnManagerStub();
        tm.setCurrent(1, alice);
        TurnBoundEnforcer e = new TurnBoundEnforcer();
        bytes memory terms = abi.encode(address(tm), uint256(1));
        vm.expectRevert(TurnBoundEnforcer.NotYourTurn.selector);
        e.beforeHook(terms, "", MODE, "", bytes32(0), bob, address(0));
    }

    // ── SystemAllowlistEnforcer ──
    function test_SystemAllowlist_AcceptsAllowed() public {
        SystemAllowlistEnforcer e = new SystemAllowlistEnforcer();
        address world = address(0x1111);
        bytes32 allowedSystem = bytes32("PlayCard");
        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = allowedSystem;
        bytes memory terms = abi.encode(world, allowed);

        bytes memory inner = hex"1122";
        bytes memory worldCall = abi.encodeWithSignature("call(bytes32,bytes)", allowedSystem, inner);
        bytes memory exec = _exec(world, 0, worldCall);

        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_SystemAllowlist_RejectsWrongSystem() public {
        SystemAllowlistEnforcer e = new SystemAllowlistEnforcer();
        address world = address(0x1111);
        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = bytes32("PlayCard");
        bytes memory terms = abi.encode(world, allowed);

        bytes memory worldCall = abi.encodeWithSignature("call(bytes32,bytes)", bytes32("Cheat"), hex"");
        bytes memory exec = _exec(world, 0, worldCall);
        vm.expectRevert(SystemAllowlistEnforcer.SystemNotAllowed.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_SystemAllowlist_RejectsWrongTarget() public {
        SystemAllowlistEnforcer e = new SystemAllowlistEnforcer();
        address world = address(0x1111);
        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = bytes32("PlayCard");
        bytes memory terms = abi.encode(world, allowed);

        bytes memory worldCall = abi.encodeWithSignature("call(bytes32,bytes)", bytes32("PlayCard"), hex"");
        bytes memory exec = _exec(address(0xDEAD), 0, worldCall); // wrong target
        vm.expectRevert(SystemAllowlistEnforcer.SystemNotAllowed.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    // ── TimestampEnforcer ──
    function test_Timestamp_AcceptsBeforeExpiry() public {
        TimestampEnforcer e = new TimestampEnforcer();
        vm.warp(1000);
        // expiresAtMs = 2_000_000 ms => 2000 s, now=1000 → ok
        bytes memory terms = abi.encode(uint256(2_000_000));
        e.beforeHook(terms, "", MODE, "", bytes32(0), address(0), address(0));
    }

    function test_Timestamp_RejectsAfterExpiry() public {
        TimestampEnforcer e = new TimestampEnforcer();
        vm.warp(3000);
        bytes memory terms = abi.encode(uint256(2_000_000)); // 2000 s < 3000 → expired
        vm.expectRevert(TimestampEnforcer.DelegationExpired.selector);
        e.beforeHook(terms, "", MODE, "", bytes32(0), address(0), address(0));
    }

    // ── LimitedCallsEnforcer ──
    function test_LimitedCalls_AllowsNThenReverts() public {
        LimitedCallsEnforcer e = new LimitedCallsEnforcer();
        bytes32 dh = bytes32("delegation-1");
        bytes memory terms = abi.encode(uint256(2));

        e.beforeHook(terms, "", MODE, "", dh, address(0), address(0)); // 1
        e.beforeHook(terms, "", MODE, "", dh, address(0), address(0)); // 2
        vm.expectRevert(LimitedCallsEnforcer.ActionLimitReached.selector);
        e.beforeHook(terms, "", MODE, "", dh, address(0), address(0)); // 3 → revert
        assertEq(e.callsUsed(address(this), dh), 2);
    }

    function test_LimitedCalls_IsolatedPerDelegationHash() public {
        LimitedCallsEnforcer e = new LimitedCallsEnforcer();
        bytes memory terms = abi.encode(uint256(1));
        e.beforeHook(terms, "", MODE, "", bytes32("d1"), address(0), address(0));
        // a different delegation hash has its own counter
        e.beforeHook(terms, "", MODE, "", bytes32("d2"), address(0), address(0));
        assertEq(e.callsUsed(address(this), bytes32("d1")), 1);
        assertEq(e.callsUsed(address(this), bytes32("d2")), 1);
    }

    // ── PerActionCapEnforcer ──
    function test_PerActionCap_AcceptsUnderCap() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, uint256(100));
        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", bob, uint256(100));
        bytes memory exec = _exec(token, 0, transfer);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_PerActionCap_RejectsOverCap() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, uint256(100));
        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", bob, uint256(101));
        bytes memory exec = _exec(token, 0, transfer);
        vm.expectRevert(PerActionCapEnforcer.PerActionCapExceeded.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_PerActionCap_AcceptsTransferFrom() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, uint256(100));
        bytes memory tf = abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, uint256(50));
        bytes memory exec = _exec(token, 0, tf);
        // delegator MUST equal the transferFrom `from` (H1): alice pulls alice's funds
        e.beforeHook(terms, "", MODE, exec, bytes32(0), alice, address(0));
    }

    function test_PerActionCap_RejectsWrongToken() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        bytes memory terms = abi.encode(address(0x70CE2), uint256(100));
        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", bob, uint256(10));
        bytes memory exec = _exec(address(0xDEAD), 0, transfer); // wrong target token
        vm.expectRevert(PerActionCapEnforcer.PerActionCapExceeded.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_PerActionCap_RejectsNonTransfer() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, uint256(100));
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", bob, uint256(1));
        bytes memory exec = _exec(token, 0, approve);
        vm.expectRevert(PerActionCapEnforcer.PerActionCapExceeded.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
    }

    function testFuzz_PerActionCap(uint256 amount, uint256 cap) public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, cap);
        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", bob, amount);
        bytes memory exec = _exec(token, 0, transfer);
        if (amount > cap) {
            vm.expectRevert(PerActionCapEnforcer.PerActionCapExceeded.selector);
            e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
        } else {
            e.beforeHook(terms, "", MODE, exec, bytes32(0), address(0), address(0));
        }
    }

    // ── C1: a direct griefer cannot inflate the manager's counter ──
    function test_LimitedCalls_GrieferCannotDoSManagerCounter() public {
        LimitedCallsEnforcer e = new LimitedCallsEnforcer();
        bytes32 victimHash = bytes32("victim-delegation");
        bytes memory terms = abi.encode(uint256(1)); // maxActions = 1

        // A griefer maxes out the cap for the victim's PUBLIC delegationHash —
        // but in the griefer's OWN (msg.sender) namespace.
        vm.prank(address(0xBAD));
        e.beforeHook(terms, "", MODE, "", victimHash, address(0), address(0));

        // The real manager (this contract) still has a fresh, usable counter.
        e.beforeHook(terms, "", MODE, "", victimHash, address(0), address(0));
        assertEq(e.callsUsed(address(this), victimHash), 1);
        assertEq(e.callsUsed(address(0xBAD), victimHash), 1);
    }

    // ── H1: per-action cap pins transferFrom `from` to the delegator ──
    function test_PerActionCap_RejectsTransferFromOtherPayer() public {
        PerActionCapEnforcer e = new PerActionCapEnforcer();
        address token = address(0x70CE2);
        bytes memory terms = abi.encode(token, uint256(100));
        // pulls from bob, but the delegator is alice → reject
        bytes memory tf = abi.encodeWithSignature("transferFrom(address,address,uint256)", bob, alice, uint256(10));
        bytes memory exec = _exec(token, 0, tf);
        vm.expectRevert(PerActionCapEnforcer.TransferFromNotDelegator.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), alice, address(0));
    }
}
