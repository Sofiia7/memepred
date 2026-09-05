// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * An ERC20 that can be called something.
 *
 * MockWETH and MockUSDC each hardcode their own name, which is right for what
 * they stand in for and wrong for a memecoin: the testnet stand-ins used
 * MockWETH on both sides of the pool, so every log line and every row in the
 * pool feed read "WETH / WETH" and no one could tell which token a market was
 * about.
 *
 * Decimals are a constructor argument too. Not needed today - everything on
 * this chain is eighteen - but a launchpad token with six or nine is exactly
 * the case that would break a price conversion quietly, and a stand-in that
 * cannot express it cannot test it.
 */
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
