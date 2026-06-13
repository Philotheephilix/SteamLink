// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {World} from "../src/world/World.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";
import {CounterGameSystem} from "../src/systems/CounterGameSystem.sol";
import {CounterTable} from "../src/codegen/tables/CounterTable.sol";
import {IWorld} from "../src/world/IWorld.sol";
import {MockForwarder} from "./mocks/MockForwarder.sol";
import {TurnBoundEnforcer} from "../src/enforcers/TurnBoundEnforcer.sol";
import {ModeCode} from "../src/delegation/IDelegation.sol";

/**
 * @notice End-to-end: a two-player turn game driven through the World router,
 *         with turn rotation in TurnManager, player attribution via the
 *         redemption seam (MockForwarder), and the TurnBoundEnforcer gating
 *         off-turn moves exactly as the live DelegationManager would.
 */
contract CounterGameTest is Test {
    World internal world;
    TurnManager internal tm;
    CounterGameSystem internal game;
    MockForwarder internal forwarder;
    TurnBoundEnforcer internal turnBound;

    bytes32 internal constant GAME_SYSTEM_ID = bytes32("CounterGame");
    uint256 internal constant ROOM = 1;
    uint256 internal constant TARGET = 3;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        world = new World();

        // TurnManager: admin is this test contract
        tm = new TurnManager(address(this));

        // Counter game system
        game = new CounterGameSystem(address(tm));

        // register table + system
        CounterTable.register(IWorld(address(world)));
        world.registerSystem(GAME_SYSTEM_ID, address(game));

        // grant the game system write access to the Counter table
        world.grantWriteAccess(CounterTable.tableId(), address(game));

        // wire the game's trusted router to the World (gates onlyWorld + seam)
        game.setTrustedRouter(address(world));

        // authorize the game system to advance turns
        tm.authorize(address(game), true);

        // seam: forwarder simulates the DelegationManager
        forwarder = new MockForwarder(world);
        world.setTrustedForwarder(address(forwarder));

        // start a 2-player game: alice then bob
        address[] memory order = new address[](2);
        order[0] = alice;
        order[1] = bob;
        tm.startTurns(ROOM, order, 100);

        turnBound = new TurnBoundEnforcer();
    }

    function _move(address player) internal returns (address winner) {
        bytes memory ret = forwarder.redeem(
            GAME_SYSTEM_ID, abi.encodeWithSignature("increment(uint256,uint256)", ROOM, TARGET), player
        );
        return abi.decode(ret, (address));
    }

    function test_FullTurnSequence_AttributionAndRotation() public {
        // alice's turn
        assertEq(tm.getCurrent(ROOM), alice);
        _move(alice);
        // counter now 1, lastMover alice, turn rotated to bob
        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1);
        assertEq(c.lastMover, alice);
        assertEq(tm.getCurrent(ROOM), bob);

        // bob's turn
        _move(bob);
        assertEq(tm.getCurrent(ROOM), alice);

        // alice wins by reaching target (value 3)
        address winner = _move(alice);
        c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 3);
        assertEq(winner, alice);
    }

    function test_OffTurnMove_RevertsInSystem() public {
        // it's alice's turn; bob attempts a move → system's own turn check reverts
        bytes memory moveCall = abi.encodeWithSignature("increment(uint256,uint256)", ROOM, TARGET);
        vm.expectRevert(CounterGameSystem.CounterGame_NotYourTurn.selector);
        forwarder.redeem(GAME_SYSTEM_ID, moveCall, bob);
    }

    function test_TurnBoundEnforcer_GatesOffTurn() public {
        // The enforcer, reading live TurnManager state, accepts alice and rejects bob.
        bytes memory terms = abi.encode(address(tm), ROOM);
        ModeCode mode = ModeCode.wrap(bytes32(0));

        // alice is current → ok
        turnBound.beforeHook(terms, "", mode, "", bytes32(0), alice, address(forwarder));

        // bob is not current → revert
        vm.expectRevert(TurnBoundEnforcer.NotYourTurn.selector);
        turnBound.beforeHook(terms, "", mode, "", bytes32(0), bob, address(forwarder));
    }
}
