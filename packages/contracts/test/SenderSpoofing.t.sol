// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {World} from "../src/world/World.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";
import {CounterGameSystem} from "../src/systems/CounterGameSystem.sol";
import {CounterTable} from "../src/codegen/tables/CounterTable.sol";
import {IWorld} from "../src/world/IWorld.sol";
import {System} from "../src/system/System.sol";
import {MockForwarder} from "./mocks/MockForwarder.sol";

/**
 * @notice FIX 1 (sender spoofing). A direct call to CounterGameSystem.increment
 *         with an appended victim address MUST NOT execute as the victim. With the
 *         fix it reverts (`onlyWorld` + the router-gated `_msgSender()`); without
 *         the fix it would read the appended bytes and act as the victim.
 */
contract SenderSpoofingTest is Test {
    World internal world;
    TurnManager internal tm;
    CounterGameSystem internal game;
    MockForwarder internal forwarder;

    bytes32 internal constant GAME_SYSTEM_ID = bytes32("CounterGame");
    uint256 internal constant ROOM = 1;
    uint256 internal constant TARGET = 3;

    address internal victim = address(0x1C71);
    address internal attacker = address(0xA77ACE);

    function setUp() public {
        world = new World();
        tm = new TurnManager(address(this));
        game = new CounterGameSystem(address(tm));

        CounterTable.register(IWorld(address(world)));
        world.registerSystem(GAME_SYSTEM_ID, address(game));
        world.grantWriteAccess(CounterTable.tableId(), address(game));
        game.setTrustedRouter(address(world));
        tm.authorize(address(game), true);

        forwarder = new MockForwarder(world);
        world.setTrustedForwarder(address(forwarder));

        // victim is the current turn in the room
        address[] memory order = new address[](2);
        order[0] = victim;
        order[1] = attacker;
        tm.startTurns(ROOM, order, 100);
    }

    /// @dev Build raw calldata for increment(roomId,target) and append a spoofed
    ///      sender as the trailing 20 bytes (ERC-2771 style), exactly what an
    ///      attacker would forge to impersonate the victim.
    function _spoofedIncrement(address spoofed) internal pure returns (bytes memory) {
        bytes memory inner = abi.encodeWithSignature("increment(uint256,uint256)", ROOM, TARGET);
        return abi.encodePacked(inner, spoofed);
    }

    /// @notice A direct call (NOT routed by the World) with an appended victim
    ///         address must revert with System_NotWorld — it must NOT execute the
    ///         move as the victim.
    function test_DirectCall_WithSpoofedVictim_Reverts() public {
        bytes memory payload = _spoofedIncrement(victim);

        vm.prank(attacker);
        (bool ok, bytes memory ret) = address(game).call(payload);

        assertFalse(ok, "direct spoofed call must revert");
        assertEq(bytes4(ret), System.System_NotWorld.selector, "must revert with System_NotWorld");

        // and the victim's turn state was untouched: no move happened
        assertEq(tm.getCurrent(ROOM), victim, "victim still current; no move executed");
        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 0, "counter untouched");
        assertEq(c.lastMover, address(0), "no last mover recorded");
    }

    /// @notice Even targeting the spoofed bytes at the attacker itself (so a turn
    ///         check would pass) the direct path still reverts before executing.
    function test_DirectCall_RevertsRegardlessOfAppendedSender() public {
        // make attacker the current player so any turn check would pass
        tm.advance(ROOM); // rotate victim -> attacker
        assertEq(tm.getCurrent(ROOM), attacker);

        bytes memory payload = _spoofedIncrement(attacker);
        vm.prank(attacker);
        (bool ok, bytes memory ret) = address(game).call(payload);

        assertFalse(ok, "direct call must revert even for a legitimate-looking sender");
        assertEq(bytes4(ret), System.System_NotWorld.selector);
    }

    /// @notice The World-routed path still works: a redemption attributes the move
    ///         to the real current player and advances the turn.
    function test_WorldRoutedPath_StillWorks() public {
        bytes memory ret = forwarder.redeem(
            GAME_SYSTEM_ID,
            abi.encodeWithSignature("increment(uint256,uint256)", ROOM, TARGET),
            victim
        );
        // increment returns winner address(0) (not yet at target)
        assertEq(abi.decode(ret, (address)), address(0));

        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1, "move executed via World");
        assertEq(c.lastMover, victim, "attributed to the real current player");
        assertEq(tm.getCurrent(ROOM), attacker, "turn rotated");
    }
}
