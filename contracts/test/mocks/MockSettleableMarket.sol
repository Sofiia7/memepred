// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/OrderbookMarket.sol";

/**
 * The five-function surface PoolOracleResolver actually uses on a market.
 *
 * The resolver casts an address to OrderbookMarket, which is unchecked, so a
 * contract answering these selectors stands in for the real one. Using it here
 * keeps the resolver's tests about the resolver: a real OrderbookMarket still
 * prices its entries through RedStone until PoolOrderbookMarket lands, and
 * dragging signed payloads into a test about pool TWAPs would obscure what
 * broke when one of them failed.
 *
 * It records what it was told to settle at, which is the assertion most of
 * those tests actually want to make.
 */
contract MockSettleableMarket {
    bytes32 public feedId;
    uint256 public duration;

    mapping(uint256 => OrderbookMarket.Match) internal matches;
    uint256[] internal ready;

    struct Settlement {
        uint256 matchId;
        uint256 exitPrice;
    }

    Settlement[] public settlements;

    constructor(bytes32 _feedId, uint256 _duration) {
        feedId = _feedId;
        duration = _duration;
    }

    function addMatch(uint256 matchId, uint256 entryPrice, uint256 settleAt) external {
        matches[matchId] = OrderbookMarket.Match({
            upOrderId: 1,
            downOrderId: 2,
            amount: 1 ether,
            entryPrice: entryPrice,
            settleAt: settleAt,
            exitPrice: 0,
            settled: false,
            upWon: false,
            lpMatch: false
        });
        ready.push(matchId);
    }

    function getMatch(uint256 matchId) external view returns (OrderbookMarket.Match memory) {
        return matches[matchId];
    }

    function getReadySettlements(uint256 offset, uint256 limit) external view returns (uint256[] memory out) {
        if (offset >= ready.length) return new uint256[](0);
        uint256 n = ready.length - offset;
        if (limit != 0 && limit < n) n = limit;
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = ready[offset + i];
        }
    }

    function settleMatch(uint256 matchId, uint256 exitPrice) external {
        OrderbookMarket.Match storage m = matches[matchId];
        require(!m.settled, "already settled");
        m.settled = true;
        m.exitPrice = exitPrice;
        settlements.push(Settlement({matchId: matchId, exitPrice: exitPrice}));
    }

    function settlementCount() external view returns (uint256) {
        return settlements.length;
    }
}
