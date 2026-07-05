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

    /// @dev Sprint 5.5 audit fix: real Pyth reverts when the stored price is
    ///      older than `age`. This was previously a no-op (ignored `age`
    ///      entirely), which meant staleness protection throughout the
    ///      codebase (OrderbookMarket.ENTRY_MAX_PRICE_AGE, OracleResolver.
    ///      MAX_PRICE_AGE) had zero test coverage — a stale price could
    ///      never actually be exercised in a test.
    function getPriceNoOlderThan(
        bytes32 id,
        uint256 age
    ) external view returns (IPyth.Price memory) {
        IPyth.Price memory p = prices[id];
        require(block.timestamp - p.publishTime <= age, "stale price");
        return p;
    }
}
