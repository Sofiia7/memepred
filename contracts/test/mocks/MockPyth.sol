// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/interfaces/IPyth.sol";

contract MockPyth is IPyth {
    mapping(bytes32 => IPyth.Price) public prices;

    function setPrice(bytes32 feedId, int64 price, int32 expo) external {
        prices[feedId] = IPyth.Price({
            price: price,
            conf: 0,
            expo: expo,
            publishTime: block.timestamp
        });
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {}

    function getPriceNoOlderThan(
        bytes32 id,
        uint256 /* age */
    ) external view returns (IPyth.Price memory) {
        return prices[id];
    }
}
