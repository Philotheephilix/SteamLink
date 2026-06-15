// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {RandomnessCoordinator} from "../src/randomness/RandomnessCoordinator.sol";

contract RandomnessTest is Test {
    RandomnessCoordinator internal rng;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        // this test contract is admin; authorize the producer accounts used below
        rng = new RandomnessCoordinator(address(this));
        rng.authorize(alice, true);
        rng.authorize(bob, true);
        // Roll forward so blockhash(commitBlock) is non-zero in tests.
        vm.roll(100);
    }

    // ── C3: an unauthorized account cannot produce randomness (no grinding) ──
    function test_RequestCommit_Unauthorized_Reverts() public {
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_NotAuthorized.selector, stranger));
        rng.requestCommit(keccak256("x"));
    }

    function test_FastRandom_Unauthorized_Reverts() public {
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_NotAuthorized.selector, stranger));
        rng.fastRandom();
    }

    // ── commit-reveal happy path: word is deterministic from inputs ──
    function test_CommitReveal_HappyPath_Deterministic() public {
        bytes32 secret = keccak256("super-secret");
        bytes32 commitment = keccak256(abi.encodePacked(secret));

        vm.prank(alice);
        uint256 requestId = rng.requestCommit(commitment);
        assertEq(requestId, 1);

        uint64 commitBlock = uint64(block.number);
        // Pin the commit-block hash so the test and contract agree on the entropy
        // source (Foundry returns 0 for un-set recent blockhashes otherwise).
        bytes32 pinnedHash = keccak256("commit-block-hash");
        vm.setBlockhash(commitBlock, pinnedHash);

        vm.roll(block.number + 1); // reveal in a later block

        vm.prank(alice);
        uint256 word = rng.reveal(requestId, secret);

        uint256 expected = uint256(keccak256(abi.encodePacked(secret, pinnedHash, alice)));
        assertEq(word, expected, "word must equal keccak256(secret, blockhash(commitBlock), requester)");
        assertTrue(word != 0);
    }

    // ── wrong secret reverts ──
    function test_Reveal_WrongSecret_Reverts() public {
        bytes32 secret = keccak256("right");
        bytes32 commitment = keccak256(abi.encodePacked(secret));

        vm.prank(alice);
        uint256 requestId = rng.requestCommit(commitment);
        vm.roll(block.number + 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_BadReveal.selector, requestId));
        rng.reveal(requestId, keccak256("wrong"));
    }

    // ── reveal in the same block as commit reverts ──
    function test_Reveal_SameBlock_Reverts() public {
        bytes32 secret = keccak256("s");
        bytes32 commitment = keccak256(abi.encodePacked(secret));

        vm.prank(alice);
        uint256 requestId = rng.requestCommit(commitment);
        // no vm.roll — still same block

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_RevealTooEarly.selector, requestId));
        rng.reveal(requestId, secret);
    }

    // ── double-reveal reverts ──
    function test_Reveal_Double_Reverts() public {
        bytes32 secret = keccak256("once");
        bytes32 commitment = keccak256(abi.encodePacked(secret));

        vm.prank(alice);
        uint256 requestId = rng.requestCommit(commitment);
        vm.roll(block.number + 1);

        vm.prank(alice);
        rng.reveal(requestId, secret);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_AlreadyRevealed.selector, requestId));
        rng.reveal(requestId, secret);
    }

    // ── only the original requester can reveal ──
    function test_Reveal_NotRequester_Reverts() public {
        bytes32 secret = keccak256("mine");
        bytes32 commitment = keccak256(abi.encodePacked(secret));

        vm.prank(alice);
        uint256 requestId = rng.requestCommit(commitment);
        vm.roll(block.number + 1);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(RandomnessCoordinator.Randomness_NotRequester.selector, requestId, bob)
        );
        rng.reveal(requestId, secret);
    }

    // ── unknown request reverts ──
    function test_Reveal_UnknownRequest_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(RandomnessCoordinator.Randomness_UnknownRequest.selector, 999));
        rng.reveal(999, keccak256("x"));
    }

    // ── fastRandom returns nonzero and varies by nonce ──
    function test_FastRandom_NonzeroAndVariesByNonce() public {
        vm.prevrandao(bytes32(uint256(0xBEEF)));

        vm.prank(alice);
        uint256 w1 = rng.fastRandom();
        vm.prank(alice);
        uint256 w2 = rng.fastRandom();

        assertTrue(w1 != 0, "fast word must be nonzero");
        assertTrue(w2 != 0, "fast word must be nonzero");
        assertTrue(w1 != w2, "successive fast words must differ (nonce advances)");
        assertEq(rng.fastNonce(alice), 2);
    }

    // ── fastRandom varies by prevrandao ──
    function test_FastRandom_VariesByPrevrandao() public {
        vm.prevrandao(bytes32(uint256(1)));
        vm.prank(alice);
        uint256 a = rng.fastRandom();

        // Fresh requester so nonce is 0 in both, isolating prevrandao as the variable.
        vm.prevrandao(bytes32(uint256(2)));
        vm.prank(bob);
        uint256 b = rng.fastRandom();

        assertTrue(a != b, "different prevrandao must give different words");
    }

    // ── dice(word, 6, 2) returns 2 values each in [1,6] ──
    function test_Dice_2d6_RangeAndCount() public view {
        uint256 word = uint256(keccak256("entropy"));
        uint8[] memory rolls = rng.dice(word, 6, 2);

        assertEq(rolls.length, 2, "2d6 yields two dice");
        for (uint256 i = 0; i < rolls.length; i++) {
            assertGe(rolls[i], 1);
            assertLe(rolls[i], 6);
        }
    }

    // ── dice is deterministic from inputs ──
    function test_Dice_Deterministic() public view {
        uint256 word = uint256(keccak256("seed"));
        uint8[] memory a = rng.dice(word, 20, 3);
        uint8[] memory b = rng.dice(word, 20, 3);
        assertEq(a.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(a[i], b[i]);
            assertGe(a[i], 1);
            assertLe(a[i], 20);
        }
    }

    // ── dice rejects bad params ──
    function test_Dice_BadParams_Reverts() public {
        vm.expectRevert(RandomnessCoordinator.Randomness_BadDiceParams.selector);
        rng.dice(123, 0, 2);

        vm.expectRevert(RandomnessCoordinator.Randomness_BadDiceParams.selector);
        rng.dice(123, 6, 0);
    }

    // ── dice fuzz: every die stays in range for any sides/count ──
    function testFuzz_Dice_InRange(uint256 word, uint8 sides, uint8 count) public view {
        sides = uint8(bound(sides, 1, 255));
        count = uint8(bound(count, 1, 32));
        uint8[] memory rolls = rng.dice(word, sides, count);
        assertEq(rolls.length, count);
        for (uint256 i = 0; i < rolls.length; i++) {
            assertGe(rolls[i], 1);
            assertLe(rolls[i], sides);
        }
    }
}
