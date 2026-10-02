// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only WETH backed one for one by deposited native ETH.
///         Unlike the earlier mintable fixture, every token can be withdrawn.
contract TestWETH is ERC20 {
    constructor() ERC20("Test Wrapped Ether", "WETH") {
        require(block.chainid != 4663 && block.chainid != 1, "Testnet only");
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "ETH withdrawal failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
