// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestUSDC
 * @notice A REAL 6-decimals ERC-20 standing in for canonical USDC on LOCAL chains
 *         (anvil) only. Base Sepolia / Base mainnet use the canonical USDC at the
 *         address supplied via env — never this. Freely mintable for funding the
 *         payer in the live charge tests.
 */
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    /// @notice USDC is a 6-decimals token; mirror that so amounts read identically.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
