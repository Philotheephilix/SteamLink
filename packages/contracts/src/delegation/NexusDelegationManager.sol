// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    Caveat,
    Delegation,
    ModeCode,
    ICaveatEnforcer,
    IDelegationManager
} from "./IDelegation.sol";

/**
 * @title NexusDelegationManager
 * @notice REAL, on-chain ERC-7710-style redemption manager for the Nexus game
 *         engine. Verifies a player's EIP-712 signed delegation, runs each
 *         caveat's before/after hooks, then EXECUTES the single delegated action
 *         into the target (typically the World) with the ERC-2771 trailing-sender
 *         append so the World/System resolves the true player.
 *
 * @dev    This is the LIVE version of `test/mocks/MockForwarder.sol`. Register it
 *         as the World's trusted forwarder (`World.setTrustedForwarder(manager)`)
 *         so the appended sender (the delegator) is trusted by the World's
 *         anti-spoofing gate.
 *
 *         STATELESS: the manager holds no redemption state. Replay/limit policy is
 *         delegated entirely to caveat enforcers (e.g. LimitedCallsEnforcer keys
 *         used-counts on the delegationHash). Per-redemption uniqueness is the
 *         caveats' responsibility, keeping the manager a pure verify-and-execute
 *         router.
 *
 *         ANY-REDEEMER RULE: a delegation with `delegate == address(0)` is an
 *         "open" delegation redeemable by ANY relayer/msg.sender. A delegation
 *         with a concrete `delegate` may only be redeemed when
 *         `msg.sender == delegate`.
 */
contract NexusDelegationManager is IDelegationManager, ReentrancyGuard {
    using ECDSA for bytes32;

    // ── EIP-712 type hashes ──
    // CAVEAT_TYPEHASH = keccak256("Caveat(address enforcer,bytes terms,bytes args)")
    bytes32 public constant CAVEAT_TYPEHASH =
        keccak256("Caveat(address enforcer,bytes terms,bytes args)");

    // DELEGATION_TYPEHASH = keccak256(
    //   "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt,uint256 maxRedemptions)"
    //   "Caveat(address enforcer,bytes terms,bytes args)"
    // )
    bytes32 public constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt,uint256 maxRedemptions)Caveat(address enforcer,bytes terms,bytes args)"
    );

    // EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant NAME_HASH = keccak256(bytes("Nexus Game Delegation"));
    bytes32 private constant VERSION_HASH = keccak256(bytes("1"));

    // ── errors ──
    error InvalidDelegationSignature();
    error BatchLengthMismatch();
    error UnauthorizedRedeemer(address expected, address actual);
    error UnsupportedChainLength();
    error ExecutionFailed();
    /// @notice executionCalldata was shorter than the ERC-7579 single-execution
    ///         header (target 20 + value 32 = 52 bytes).
    error InvalidExecutionCalldata();
    /// @notice The manager holds no ETH and is non-payable; non-zero `value` in a
    ///         decoded execution is unsupported.
    error NonZeroValueUnsupported();
    /// @notice The signed `maxRedemptions` cap has been reached for this delegation.
    error DelegationRedemptionLimitReached(bytes32 delegationHash);
    /// @notice A delegation signed with `maxRedemptions == 0` is unusable.
    error ZeroMaxRedemptions();
    /// @notice Only root authority (bytes32(0)) delegations are supported; delegation
    ///         chains are not implemented in this manager.
    error NonRootAuthorityUnsupported(bytes32 authority);

    // ── replay guard: per-delegation redemption counter keyed on the EIP-712
    //    struct hash (same value returned by getDelegationHash) ──
    mapping(bytes32 => uint256) public redemptionsOf;

    // ── events ──
    event Redeemed(
        bytes32 indexed delegationHash,
        address indexed delegator,
        address indexed redeemer,
        address target
    );

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 view helpers (cross-checkable from TS/viem live scripts)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice EIP-712 domain separator bound to this manager and chain.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @notice The EIP-712 hashStruct of a Delegation (the value prefixed with
    ///         \x19\x01 || domainSeparator to form the signing digest).
    function getDelegationHash(Delegation calldata delegation) public pure returns (bytes32) {
        return _hashDelegation(delegation);
    }

    /// @notice The full typed-data digest used for ecrecover.
    function getTypedDataDigest(Delegation calldata delegation) public view returns (bytes32) {
        return _digest(_hashDelegation(delegation));
    }

    function _hashCaveat(Caveat memory c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms), keccak256(c.args))
        );
    }

    function _hashCaveatsArray(Caveat[] memory caveats) private pure returns (bytes32) {
        // Linear-cost EIP-712 array hash: hash each element, then keccak the
        // concatenation. Equivalent encoding to the previous accumulation but O(n).
        bytes32[] memory hashes = new bytes32[](caveats.length);
        for (uint256 i = 0; i < caveats.length; i++) {
            hashes[i] = _hashCaveat(caveats[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _hashDelegation(Delegation memory d) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DELEGATION_TYPEHASH,
                d.delegate,
                d.delegator,
                d.authority,
                _hashCaveatsArray(d.caveats),
                d.salt,
                d.maxRedemptions
            )
        );
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Redemption
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDelegationManager
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        ModeCode[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external nonReentrant {
        if (permissionContexts.length != modes.length || modes.length != executionCallDatas.length) {
            revert BatchLengthMismatch();
        }

        for (uint256 i = 0; i < permissionContexts.length; i++) {
            _redeemOne(permissionContexts[i], modes[i], executionCallDatas[i]);
        }
    }

    function _redeemOne(
        bytes calldata permissionContext,
        ModeCode mode,
        bytes calldata executionCalldata
    ) private {
        // permissionContext = abi.encode(Delegation). Single-delegation chains only.
        Delegation memory delegation = abi.decode(permissionContext, (Delegation));

        // 0) only root-authority delegations are supported (no delegation chains).
        //    The TS SDK signs authority = bytes32(0).
        if (delegation.authority != bytes32(0)) {
            revert NonRootAuthorityUnsupported(delegation.authority);
        }

        // 1) verify the EIP-712 signature is valid FOR the delegator. SignatureChecker
        //    accepts BOTH a raw ECDSA signature (an EOA delegator — bots + guest
        //    wallets) AND an ERC-1271 `isValidSignature` response (a smart-account
        //    delegator — e.g. a MetaMask Smart Account / EIP-7702-upgraded EOA). This
        //    is what lets a real MetaMask Smart Account sign the single delegation.
        bytes32 structHash = _hashDelegation(delegation);
        bytes32 digest = _digest(structHash);
        if (!SignatureChecker.isValidSignatureNow(delegation.delegator, digest, delegation.signature)) {
            revert InvalidDelegationSignature();
        }

        // 2) redeemer authorization: open (address(0)) => anyone; else must match
        address redeemer = msg.sender;
        if (delegation.delegate != address(0) && delegation.delegate != redeemer) {
            revert UnauthorizedRedeemer(delegation.delegate, redeemer);
        }

        // 2b) bounded replay guard: a zero cap is unusable; otherwise enforce the
        //     signed maxRedemptions via a per-delegation counter keyed on structHash.
        if (delegation.maxRedemptions == 0) revert ZeroMaxRedemptions();
        if (redemptionsOf[structHash] >= delegation.maxRedemptions) {
            revert DelegationRedemptionLimitReached(structHash);
        }
        redemptionsOf[structHash] += 1;

        // 3) run beforeHooks
        uint256 n = delegation.caveats.length;
        for (uint256 j = 0; j < n; j++) {
            Caveat memory c = delegation.caveats[j];
            ICaveatEnforcer(c.enforcer).beforeHook(
                c.terms, c.args, mode, executionCalldata, structHash, delegation.delegator, redeemer
            );
        }

        // 4) execute the single action with ERC-2771 trailing-sender append
        (address target, uint256 value, bytes calldata callData) = _decodeExecution(executionCalldata);
        // The manager is non-payable and holds no ETH; reject any non-zero value
        // up front with a named error rather than failing opaquely in target.call.
        if (value != 0) revert NonZeroValueUnsupported();
        bytes memory payload = abi.encodePacked(callData, delegation.delegator);
        (bool ok, bytes memory ret) = target.call{value: value}(payload);
        if (!ok) {
            // bubble the revert reason / named custom error unchanged
            if (ret.length == 0) revert ExecutionFailed();
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        // 5) run afterHooks
        for (uint256 j = 0; j < n; j++) {
            Caveat memory c = delegation.caveats[j];
            ICaveatEnforcer(c.enforcer).afterHook(
                c.terms, c.args, mode, executionCalldata, structHash, delegation.delegator, redeemer
            );
        }

        emit Redeemed(structHash, delegation.delegator, redeemer, target);
    }

    /// @dev ERC-7579 single-execution layout: packed(target(20), value(32), callData).
    function _decodeExecution(bytes calldata executionCalldata)
        private
        pure
        returns (address target, uint256 value, bytes calldata callData)
    {
        // Guard the slice with a named error instead of an opaque array-bounds
        // panic when the header (target 20 + value 32) is missing.
        if (executionCalldata.length < 52) revert InvalidExecutionCalldata();
        target = address(bytes20(executionCalldata[0:20]));
        value = uint256(bytes32(executionCalldata[20:52]));
        callData = executionCalldata[52:];
    }
}
