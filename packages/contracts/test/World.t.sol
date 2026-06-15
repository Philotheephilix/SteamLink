// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {World} from "../src/world/World.sol";
import {IWorld, IStoreEvents} from "../src/world/IWorld.sol";
import {System} from "../src/system/System.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal system that echoes back the resolved player (_msgSender).
contract EchoSystem is System {
    event Echo(address sender);

    function setTrustedRouter(address router) external {
        _setTrustedRouter(router);
    }

    function whoAmI() external returns (address) {
        address s = _msgSender();
        emit Echo(s);
        return s;
    }

    function boom() external pure {
        revert("EchoSystem: boom");
    }
}

contract WorldTest is Test {
    World internal world;
    EchoSystem internal echo;

    bytes32 internal constant TABLE_ID = bytes32("PlayerTable");
    bytes32 internal constant SYSTEM_ID = bytes32("EchoSystem");

    address internal alice = address(0xA11CE);
    address internal writer = address(0xBEEF);

    function setUp() public {
        world = new World();
        echo = new EchoSystem();
        string[] memory f = new string[](1);
        f[0] = "value";
        world.registerTable(TABLE_ID, bytes32(uint256(1)), bytes32(uint256(1)), f);
        world.registerSystem(SYSTEM_ID, address(echo));
        echo.setTrustedRouter(address(world));
    }

    function _key(uint256 k) internal pure returns (bytes32[] memory key) {
        key = new bytes32[](1);
        key[0] = bytes32(k);
    }

    // ── store round-trip + event ──
    function test_SetGetRecord_RoundTrip() public {
        world.grantWriteAccess(TABLE_ID, address(this));
        bytes memory s = abi.encode(uint256(42));
        bytes memory d = hex"deadbeef";

        bytes32[] memory key = _key(1);
        vm.expectEmit(true, false, false, true, address(world));
        emit IStoreEvents.Store_SetRecord(TABLE_ID, key, s, d);
        world.setRecord(TABLE_ID, key, s, d);

        (bytes memory gotS, bytes memory gotD) = world.getRecord(TABLE_ID, key);
        assertEq(gotS, s);
        assertEq(gotD, d);
        assertTrue(world.recordExists(TABLE_ID, key));
    }

    function test_DeleteRecord_EmitsEvent() public {
        world.grantWriteAccess(TABLE_ID, address(this));
        bytes32[] memory key = _key(1);
        world.setRecord(TABLE_ID, key, abi.encode(uint256(1)), "");

        vm.expectEmit(true, false, false, true, address(world));
        emit IStoreEvents.Store_DeleteRecord(TABLE_ID, key);
        world.deleteRecord(TABLE_ID, key);
        assertFalse(world.recordExists(TABLE_ID, key));
    }

    // ── access control ──
    function test_SetRecord_RevertsForNonWriter() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(World.World_AccessDenied.selector, TABLE_ID, alice));
        world.setRecord(TABLE_ID, _key(1), abi.encode(uint256(1)), "");
    }

    function test_GrantThenRevokeWriteAccess() public {
        world.grantWriteAccess(TABLE_ID, writer);
        vm.prank(writer);
        world.setRecord(TABLE_ID, _key(1), abi.encode(uint256(7)), "");

        world.revokeWriteAccess(TABLE_ID, writer);
        vm.prank(writer);
        vm.expectRevert();
        world.setRecord(TABLE_ID, _key(1), abi.encode(uint256(8)), "");
    }

    function test_RegisterTable_OnlyOwner() public {
        string[] memory f = new string[](0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        world.registerTable(bytes32("X"), 0, 0, f);
    }

    function test_GetRecord_UnregisteredTable_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(World.World_TableNotFound.selector, bytes32("nope")));
        world.getRecord(bytes32("nope"), _key(1));
    }

    // ── routing ──
    function test_Call_RoutesToSystem_DirectSender() public {
        // direct call path: _msgSender resolves to msg.sender (this test contract)
        bytes memory ret = world.call(SYSTEM_ID, abi.encodeWithSignature("whoAmI()"));
        address who = abi.decode(ret, (address));
        assertEq(who, address(this));
    }

    function test_Call_UnregisteredSystem_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(World.World_SystemNotFound.selector, bytes32("ghost")));
        world.call(bytes32("ghost"), "");
    }

    function test_Call_BubblesRevert() public {
        vm.expectRevert(bytes("EchoSystem: boom"));
        world.call(SYSTEM_ID, abi.encodeWithSignature("boom()"));
    }

    // ── H4: a locked system can never be re-pointed ──
    function test_LockSystem_PreventsReplacement() public {
        EchoSystem other = new EchoSystem();
        world.lockSystem(SYSTEM_ID);
        assertTrue(world.systemLocked(SYSTEM_ID));
        vm.expectRevert(abi.encodeWithSelector(World.World_SystemIsLocked.selector, SYSTEM_ID));
        world.registerSystem(SYSTEM_ID, address(other));
        // original implementation is unchanged
        assertEq(world.getSystemAddress(SYSTEM_ID), address(echo));
    }

    function test_LockSystem_UnknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(World.World_SystemNotFound.selector, bytes32("ghost")));
        world.lockSystem(bytes32("ghost"));
    }

    function test_LockSystem_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        world.lockSystem(SYSTEM_ID);
    }
}
