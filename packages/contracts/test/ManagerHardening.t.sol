// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {NexusDelegationManager} from "../src/delegation/NexusDelegationManager.sol";
import {Caveat, Delegation, ModeCode} from "../src/delegation/IDelegation.sol";

/**
 * @notice A malicious execution target that re-enters redeemDelegations on call.
 *         Used to prove `nonReentrant` blocks reentrancy (FIX 2).
 */
contract ReentrantTarget {
    NexusDelegationManager public immutable manager;
    bytes public storedCtx;
    bytes public storedExec;
    bool public attacked;

    constructor(NexusDelegationManager _manager) {
        manager = _manager;
    }

    function arm(bytes calldata ctx, bytes calldata exec) external {
        storedCtx = ctx;
        storedExec = exec;
    }

    // Any call into this contract (the execution target) re-enters the manager.
    fallback() external payable {
        if (!attacked) {
            attacked = true;
            bytes[] memory ctxs = new bytes[](1);
            ctxs[0] = storedCtx;
            ModeCode[] memory modes = new ModeCode[](1);
            modes[0] = ModeCode.wrap(bytes32(0));
            bytes[] memory execs = new bytes[](1);
            execs[0] = storedExec;
            // This MUST revert due to nonReentrant; bubble it up to fail the outer call.
            manager.redeemDelegations(ctxs, modes, execs);
        }
    }

    receive() external payable {}
}

contract ManagerHardeningTest is Test {
    NexusDelegationManager internal manager;

    uint256 internal alicePk = 0xA11CE;
    address internal alice;
    address internal relayer = address(0xBEEF);

    function setUp() public {
        alice = vm.addr(alicePk);
        manager = new NexusDelegationManager();
    }

    function _signed(Delegation memory d, uint256 pk) internal view returns (Delegation memory) {
        bytes32 digest = manager.getTypedDataDigest(d);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        d.signature = abi.encodePacked(r, s, v);
        return d;
    }

    function _delegation(address delegate, uint256 salt) internal view returns (Delegation memory) {
        Delegation memory d = Delegation({
            delegate: delegate,
            delegator: alice,
            authority: bytes32(0),
            caveats: new Caveat[](0),
            salt: salt,
            maxRedemptions: 1,
            signature: ""
        });
        return _signed(d, alicePk);
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

    /// @dev exec = packed(target, value, callData).
    function _exec(address target, uint256 value, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, callData);
    }

    // ── FIX 2a: reentrancy ──
    function test_Reentrancy_Reverts() public {
        ReentrantTarget target = new ReentrantTarget(manager);

        // open delegation so the re-entrant inner redeem passes redeemer auth
        Delegation memory d = _delegation(address(0), 1);
        bytes memory ctx = abi.encode(d);
        bytes memory exec = _exec(address(target), 0, hex"deadbeef");

        target.arm(ctx, exec);

        // Outer redemption calls into target, which re-enters redeemDelegations.
        // The reentrant call hits ReentrancyGuard and reverts; that revert bubbles
        // through target.call back into the manager, surfacing as ExecutionFailed
        // (the inner revert has no return data after the guard's reentrancy revert
        // is bubbled). Either way: the outer redeem MUST revert.
        vm.prank(relayer);
        vm.expectRevert();
        _redeem(d, exec);
    }

    // ── FIX 2b: short executionCalldata (<52 bytes) ──
    function test_ShortExecutionCalldata_RevertsNamed() public {
        Delegation memory d = _delegation(relayer, 2);

        // only 51 bytes: 20 (target) + 31 (truncated value) — below the 52 header
        bytes memory shortExec = new bytes(51);

        vm.prank(relayer);
        vm.expectRevert(NexusDelegationManager.InvalidExecutionCalldata.selector);
        _redeem(d, shortExec);
    }

    function test_EmptyExecutionCalldata_RevertsNamed() public {
        Delegation memory d = _delegation(relayer, 3);

        vm.prank(relayer);
        vm.expectRevert(NexusDelegationManager.InvalidExecutionCalldata.selector);
        _redeem(d, "");
    }

    // ── FIX 2c: non-zero value ──
    function test_NonZeroValue_RevertsNamed() public {
        Delegation memory d = _delegation(relayer, 4);

        // target is irrelevant; value != 0 must be rejected before the call
        bytes memory exec = _exec(address(0xCAFE), 1 wei, hex"");

        vm.prank(relayer);
        vm.expectRevert(NexusDelegationManager.NonZeroValueUnsupported.selector);
        _redeem(d, exec);
    }
}
