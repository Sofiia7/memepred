// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockResolver {
    address public pyth;

    constructor(address _pyth) {
        pyth = _pyth;
    }
}
