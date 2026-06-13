// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {World} from "../src/world/World.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";
import {CounterGameSystem} from "../src/systems/CounterGameSystem.sol";
import {CounterTable} from "../src/codegen/tables/CounterTable.sol";
import {IWorld} from "../src/world/IWorld.sol";
import {TurnBoundEnforcer} from "../src/enforcers/TurnBoundEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {NexusDelegationManager} from "../src/delegation/NexusDelegationManager.sol";
import {Caveat, Delegation, ModeCode} from "../src/delegation/IDelegation.sol";

/**
 * @notice LIVE redemption tests: a real EIP-712 signature (vm.sign over the
 *         manager's in-Solidity digest) is verified, caveats run, and the action
 *         executes into the World so the delegator surfaces as _msgSender.
 */
contract NexusDelegationManagerTest is Test {
    World internal world;
    TurnManager internal tm;
    CounterGameSystem internal game;
    NexusDelegationManager internal manager;
    TurnBoundEnforcer internal turnBound;
    PerActionCapEnforcer internal capEnforcer;

    bytes32 internal constant GAME_SYSTEM_ID = bytes32("CounterGame");
    uint256 internal constant ROOM = 1;
    uint256 internal constant TARGET = 3;

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    address internal alice;
    address internal bob;

    address internal relayer = address(0xBEEF);

    function setUp() public {
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);

        world = new World();
        tm = new TurnManager(address(this));
        game = new CounterGameSystem(address(tm));

        CounterTable.register(IWorld(address(world)));
        world.registerSystem(GAME_SYSTEM_ID, address(game));
        world.grantWriteAccess(CounterTable.tableId(), address(game));
        game.setTrustedRouter(address(world));
        tm.authorize(address(game), true);

        // LIVE manager as the World's trusted forwarder
        manager = new NexusDelegationManager();
        world.setTrustedForwarder(address(manager));

        // turn order: alice then bob
        address[] memory order = new address[](2);
        order[0] = alice;
        order[1] = bob;
        tm.startTurns(ROOM, order, 100);

        turnBound = new TurnBoundEnforcer();
        capEnforcer = new PerActionCapEnforcer();
    }

    // ── helpers ──

    /// @dev Build the executionCalldata: packed(target=world, value=0, callData)
    ///      where callData = World.call(systemId, innerCall).
    function _execForWorldCall(bytes memory innerCall) internal view returns (bytes memory) {
        bytes memory worldCall = abi.encodeWithSignature("call(bytes32,bytes)", GAME_SYSTEM_ID, innerCall);
        return abi.encodePacked(address(world), uint256(0), worldCall);
    }

    function _incrementCall() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("increment(uint256,uint256)", ROOM, TARGET);
    }

    function _signDelegation(Delegation memory d, uint256 pk) internal view returns (Delegation memory) {
        bytes32 digest = manager.getTypedDataDigest(d);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        d.signature = abi.encodePacked(r, s, v);
        return d;
    }

    function _emptyCaveats() internal pure returns (Caveat[] memory) {
        return new Caveat[](0);
    }

    function _redeem(Delegation memory d, bytes memory exec) internal {
        bytes[] memory ctxs = new bytes[](1);
        ctxs[0] = abi.encode(d);
        ModeCode[] memory modes = new ModeCode[](1);
        modes[0] = ModeCode.wrap(bytes32(0));
        bytes[] memory execs = new bytes[](1);
        execs[0] = exec;
        manager.redeemDelegations(ctxs, modes, execs);
    }

    /// @dev Identity bounce: memory -> calldata so we can pass to view fns that
    ///      take `Delegation calldata`.
    function _passthrough(Delegation memory d) external pure returns (Delegation memory) {
        return d;
    }

    // ── tests ──

    function test_HappyPath_RedeemsAndAttributesDelegator() public {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 1,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        assertEq(tm.getCurrent(ROOM), alice);

        vm.prank(relayer);
        _redeem(d, _execForWorldCall(_incrementCall()));

        // World/CounterGame saw alice as _msgSender → counter moved, turn rotated
        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1);
        assertEq(c.lastMover, alice);
        assertEq(tm.getCurrent(ROOM), bob);
    }

    function test_TamperedSignature_Reverts() public {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 2,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);
        // flip a byte in the signature
        d.signature[10] = bytes1(uint8(d.signature[10]) ^ 0xFF);

        vm.prank(relayer);
        vm.expectRevert();
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    function test_WrongSigner_RevertsInvalidSignature() public {
        // delegator claims to be alice but bob signs it
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 3,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, bobPk); // wrong key

        vm.prank(relayer);
        vm.expectRevert(NexusDelegationManager.InvalidDelegationSignature.selector);
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    function test_DelegateBound_WrongRedeemerReverts() public {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 4,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        // redeemed by a different sender than `delegate`
        vm.prank(address(0xDEAD));
        vm.expectRevert(
            abi.encodeWithSelector(
                NexusDelegationManager.UnauthorizedRedeemer.selector, relayer, address(0xDEAD)
            )
        );
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    function test_DelegateBound_CorrectRedeemerSucceeds() public {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 5,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        vm.prank(relayer);
        _redeem(d, _execForWorldCall(_incrementCall()));

        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1);
    }

    function test_OpenDelegation_AnyoneCanRedeem() public {
        Delegation memory d = Delegation({
            delegate: address(0), // open
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 6,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        // an arbitrary redeemer
        vm.prank(address(0x1234));
        _redeem(d, _execForWorldCall(_incrementCall()));

        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1);
        assertEq(c.lastMover, alice);
    }

    function test_TurnBoundEnforcer_WrongTurnReverts() public {
        // bob signs a delegation but it's alice's turn → TurnBoundEnforcer reverts
        Caveat[] memory caveats = new Caveat[](1);
        caveats[0] = Caveat({
            enforcer: address(turnBound),
            terms: abi.encode(address(tm), ROOM),
            args: ""
        });
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: bob,
            authority: bytes32(0),
            caveats: caveats,
            salt: 7,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, bobPk);

        vm.prank(relayer);
        vm.expectRevert(TurnBoundEnforcer.NotYourTurn.selector);
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    function test_TurnBoundEnforcer_RightTurnSucceeds() public {
        // alice's turn, alice's delegation with the turn-bound caveat → ok
        Caveat[] memory caveats = new Caveat[](1);
        caveats[0] = Caveat({
            enforcer: address(turnBound),
            terms: abi.encode(address(tm), ROOM),
            args: ""
        });
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: caveats,
            salt: 8,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        vm.prank(relayer);
        _redeem(d, _execForWorldCall(_incrementCall()));

        CounterTable.CounterData memory c = CounterTable.get(IWorld(address(world)), ROOM);
        assertEq(c.value, 1);
    }

    function test_PerActionCapEnforcer_OverCapReverts() public {
        // The cap enforcer inspects the executionCalldata's (target,value,callData)
        // directly. Build an ERC-20 transfer over the cap.
        MockERC20 token = new MockERC20();
        uint256 cap = 100;

        Caveat[] memory caveats = new Caveat[](1);
        caveats[0] = Caveat({
            enforcer: address(capEnforcer),
            terms: abi.encode(address(token), cap),
            args: ""
        });
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: caveats,
            salt: 9,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        // execution: token.transfer(bob, 101) — over the per-action cap
        bytes memory transferCall = abi.encodeWithSignature("transfer(address,uint256)", bob, cap + 1);
        bytes memory exec = abi.encodePacked(address(token), uint256(0), transferCall);

        vm.prank(relayer);
        vm.expectRevert(PerActionCapEnforcer.PerActionCapExceeded.selector);
        _redeem(d, exec);
    }

    function test_DomainSeparatorAndHash_StableNonzero() public view {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 10,
            maxRedemptions: 1,
            signature: ""
        });

        bytes32 ds = manager.domainSeparator();
        bytes32 h = manager.getDelegationHash(d);

        assertTrue(ds != bytes32(0));
        assertTrue(h != bytes32(0));
        // stable across calls
        assertEq(ds, manager.domainSeparator());
        assertEq(h, manager.getDelegationHash(d));
    }

    // ── C1: bounded replay guard via signed maxRedemptions ──

    function test_Replay_BeyondMaxRedemptions_Reverts() public {
        // maxRedemptions = 1: first redeem ok, second reverts with the limit error.
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 100,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        vm.prank(relayer);
        _redeem(d, _execForWorldCall(_incrementCall()));

        bytes32 h = manager.getDelegationHash(this._passthrough(d));
        assertEq(manager.redemptionsOf(h), 1);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(NexusDelegationManager.DelegationRedemptionLimitReached.selector, h)
        );
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    function test_Redemption_WithinMaxRedemptions_Succeeds() public {
        // maxRedemptions = 2: two redemptions both succeed; the counter tracks them.
        // Use a plain ERC-20 transfer target (no turn-state dependency) so the
        // action can repeat independent of the game's turn rotation.
        MockERC20 token = new MockERC20();
        token.mint(address(manager), 10);

        Delegation memory d = Delegation({
            delegate: address(0), // open so any relayer can redeem repeatedly
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 101,
            maxRedemptions: 2,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        bytes memory transferCall = abi.encodeWithSignature("transfer(address,uint256)", bob, uint256(1));
        bytes memory exec = abi.encodePacked(address(token), uint256(0), transferCall);

        vm.prank(address(0x1111));
        _redeem(d, exec);
        vm.prank(address(0x2222));
        _redeem(d, exec);

        bytes32 h = manager.getDelegationHash(this._passthrough(d));
        assertEq(manager.redemptionsOf(h), 2);
        assertEq(token.balanceOf(bob), 2);

        // third redemption exceeds the cap.
        vm.prank(address(0x3333));
        vm.expectRevert(
            abi.encodeWithSelector(NexusDelegationManager.DelegationRedemptionLimitReached.selector, h)
        );
        _redeem(d, exec);
    }

    function test_ZeroMaxRedemptions_Reverts() public {
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: bytes32(0),
            caveats: _emptyCaveats(),
            salt: 102,
            maxRedemptions: 0,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        vm.prank(relayer);
        vm.expectRevert(NexusDelegationManager.ZeroMaxRedemptions.selector);
        _redeem(d, _execForWorldCall(_incrementCall()));
    }

    // ── C2: only root authority (bytes32(0)) is supported ──
    function test_NonRootAuthority_Reverts() public {
        bytes32 authority = bytes32(uint256(0xDEAD));
        Delegation memory d = Delegation({
            delegate: relayer,
            delegator: alice,
            authority: authority,
            caveats: _emptyCaveats(),
            salt: 103,
            maxRedemptions: 1,
            signature: ""
        });
        d = _signDelegation(d, alicePk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(NexusDelegationManager.NonRootAuthorityUnsupported.selector, authority)
        );
        _redeem(d, _execForWorldCall(_incrementCall()));
    }
}
