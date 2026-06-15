// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ModeCode} from "../src/delegation/IDelegation.sol";
import {ERC20TransferAmountEnforcer} from "../src/enforcers/ERC20TransferAmountEnforcer.sol";
import {AllowedRecipientsEnforcer} from "../src/enforcers/AllowedRecipientsEnforcer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract BudgetEnforcersTest is Test {
    ModeCode internal constant MODE = ModeCode.wrap(bytes32(0));
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCC0);

    MockERC20 internal token;

    function setUp() public {
        token = new MockERC20();
    }

    // ERC-7579 single-execution calldata = target(20) ++ value(32) ++ callData
    function _execTransfer(address tok, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(tok, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _execTransferFrom(address tok, address from, address to, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tok, uint256(0), abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    // ── ERC20TransferAmountEnforcer (lifetime cumulative cap) ──
    function test_ERC20TransferAmount_AccumulatesUnderCap() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes32 dh = bytes32("budget-1");
        bytes memory terms = abi.encode(address(token), uint256(100));

        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 40), dh, alice, address(0));
        assertEq(e.spentMap(address(this), dh), 40);
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 50), dh, alice, address(0));
        assertEq(e.spentMap(address(this), dh), 90);
    }

    function test_ERC20TransferAmount_RevertsOverLifetimeCap() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes32 dh = bytes32("budget-1");
        bytes memory terms = abi.encode(address(token), uint256(100));

        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 60), dh, alice, address(0));
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 30), dh, alice, address(0));
        assertEq(e.spentMap(address(this), dh), 90);

        // this redemption (90 + 20 = 110) pushes cumulative over the cap of 100
        vm.expectRevert(ERC20TransferAmountEnforcer.ERC20TransferAmountExceeded.selector);
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 20), dh, alice, address(0));
        // state unchanged after revert
        assertEq(e.spentMap(address(this), dh), 90);
    }

    function test_ERC20TransferAmount_IsolatedPerDelegationHash() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes memory terms = abi.encode(address(token), uint256(100));
        bytes32 d1 = bytes32("d1");
        bytes32 d2 = bytes32("d2");

        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 90), d1, alice, address(0));
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 90), d2, alice, address(0));
        assertEq(e.spentMap(address(this), d1), 90);
        assertEq(e.spentMap(address(this), d2), 90);
    }

    function test_ERC20TransferAmount_AcceptsTransferFrom() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes32 dh = bytes32("budget-tf");
        bytes memory terms = abi.encode(address(token), uint256(100));
        e.beforeHook(terms, "", MODE, _execTransferFrom(address(token), alice, bob, 50), dh, alice, address(0));
        assertEq(e.spentMap(address(this), dh), 50);
    }

    function test_ERC20TransferAmount_RejectsWrongToken() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes memory terms = abi.encode(address(token), uint256(100));
        vm.expectRevert(ERC20TransferAmountEnforcer.ERC20TransferAmountExceeded.selector);
        e.beforeHook(terms, "", MODE, _execTransfer(address(0xDEAD), bob, 10), bytes32(0), alice, address(0));
    }

    function test_ERC20TransferAmount_RejectsNonTransfer() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes memory terms = abi.encode(address(token), uint256(100));
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", bob, uint256(1));
        bytes memory exec = abi.encodePacked(address(token), uint256(0), approve);
        vm.expectRevert(ERC20TransferAmountEnforcer.ERC20TransferAmountExceeded.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), alice, address(0));
    }

    // ── AllowedRecipientsEnforcer ──
    function test_AllowedRecipients_AcceptsAllowed() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](2);
        allowed[0] = bob;
        allowed[1] = carol;
        bytes memory terms = abi.encode(address(token), allowed);
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), carol, 10), bytes32(0), alice, address(0));
    }

    function test_AllowedRecipients_RejectsNotAllowed() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](1);
        allowed[0] = bob;
        bytes memory terms = abi.encode(address(token), allowed);
        vm.expectRevert(AllowedRecipientsEnforcer.RecipientNotAllowed.selector);
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), carol, 10), bytes32(0), alice, address(0));
    }

    function test_AllowedRecipients_TransferFromChecksSecondArg() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](1);
        allowed[0] = bob; // bob is the allowed recipient (`to`)
        bytes memory terms = abi.encode(address(token), allowed);

        // transferFrom(carol -> bob): `to` (2nd arg) is bob → allowed.
        // delegator MUST equal `from` (H1), so carol is the delegator here.
        e.beforeHook(terms, "", MODE, _execTransferFrom(address(token), carol, bob, 10), bytes32(0), carol, address(0));

        // transferFrom(bob -> carol): `to` (2nd arg) is carol → not allowed,
        // even though bob (the `from`/1st arg, = delegator) is on the allowlist
        vm.expectRevert(AllowedRecipientsEnforcer.RecipientNotAllowed.selector);
        e.beforeHook(terms, "", MODE, _execTransferFrom(address(token), bob, carol, 10), bytes32(0), bob, address(0));
    }

    function test_AllowedRecipients_RejectsWrongToken() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](1);
        allowed[0] = bob;
        bytes memory terms = abi.encode(address(token), allowed);
        vm.expectRevert(AllowedRecipientsEnforcer.RecipientNotAllowed.selector);
        e.beforeHook(terms, "", MODE, _execTransfer(address(0xDEAD), bob, 10), bytes32(0), alice, address(0));
    }

    function test_AllowedRecipients_RejectsNonTransfer() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](1);
        allowed[0] = bob;
        bytes memory terms = abi.encode(address(token), allowed);
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", bob, uint256(1));
        bytes memory exec = abi.encodePacked(address(token), uint256(0), approve);
        vm.expectRevert(AllowedRecipientsEnforcer.RecipientNotAllowed.selector);
        e.beforeHook(terms, "", MODE, exec, bytes32(0), alice, address(0));
    }

    // ── H1: lifetime cap pins transferFrom `from` to the delegator ──
    function test_ERC20TransferAmount_RejectsTransferFromOtherPayer() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes memory terms = abi.encode(address(token), uint256(1000));
        // delegator is alice, but the transferFrom pulls bob's funds → reject
        vm.expectRevert(ERC20TransferAmountEnforcer.TransferFromNotDelegator.selector);
        e.beforeHook(terms, "", MODE, _execTransferFrom(address(token), bob, carol, 10), bytes32("x"), alice, address(0));
    }

    function test_AllowedRecipients_RejectsTransferFromOtherPayer() public {
        AllowedRecipientsEnforcer e = new AllowedRecipientsEnforcer();
        address[] memory allowed = new address[](1);
        allowed[0] = carol;
        bytes memory terms = abi.encode(address(token), allowed);
        // recipient carol is allowed, but `from` (bob) != delegator (alice) → reject
        vm.expectRevert(AllowedRecipientsEnforcer.TransferFromNotDelegator.selector);
        e.beforeHook(terms, "", MODE, _execTransferFrom(address(token), bob, carol, 10), bytes32(0), alice, address(0));
    }

    // ── C1: a direct griefer cannot inflate the manager's cumulative spend ──
    function test_ERC20TransferAmount_GrieferCannotDoSManagerSpend() public {
        ERC20TransferAmountEnforcer e = new ERC20TransferAmountEnforcer();
        bytes32 victimHash = bytes32("victim");
        bytes memory terms = abi.encode(address(token), uint256(100));

        vm.prank(address(0xBAD));
        e.beforeHook(terms, "", MODE, _execTransfer(address(token), bob, 100), victimHash, alice, address(0));

        // The manager's (this contract's) namespace is untouched.
        assertEq(e.spentMap(address(this), victimHash), 0);
        assertEq(e.spentMap(address(0xBAD), victimHash), 100);
    }
}
