// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @notice Minimal ERC-1271 smart account: validates a signature by recovering it
 *         and comparing to a single owner key. Stands in for a real MetaMask Smart
 *         Account / EIP-7702-upgraded EOA in the manager's signature-verification
 *         tests — the manager must accept its `isValidSignature` response, not an
 *         ECDSA recover of the account address.
 */
contract MockSmartAccount {
    bytes4 internal constant MAGIC = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC;
        return 0xffffffff;
    }
}
