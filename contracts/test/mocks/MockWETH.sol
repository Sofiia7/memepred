// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * An 18-decimal stake token, standing in for WETH on Robinhood Chain.
 *
 * Separate from MockUSDC rather than a decimals parameter on it: the decimal
 * width is the thing under test here. Every stake bound in PoolOrderbookMarket
 * is restated because 1e6 means a dollar in one world and dust in the other,
 * and a mock that could be either would let that distinction go unchecked.
 *
 * deposit() is present because the real WETH has it; nothing in the protocol
 * calls it, markets take WETH by transferFrom like any ERC20.
 */
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}
