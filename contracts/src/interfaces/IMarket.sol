// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarket {
    enum Direction { UP, DOWN }
    enum Status { OPEN, CLOSED, RESOLVED, REFUNDED }

    struct Bet {
        address trader;
        uint256 amount;
        Direction direction;
        address referrer;
        bool claimed;
    }

    event BetPlaced(
        address indexed trader,
        Direction direction,
        uint256 amount,
        address referrer,
        uint256 timestamp
    );

    event MarketSettled(
        bool upWon,
        uint256 entryPrice,
        uint256 exitPrice,
        uint256 totalUpPool,
        uint256 totalDownPool
    );

    event Claimed(address indexed trader, uint256 payout);
    event EmergencyRefund(address indexed trader, uint256 amount);

    function placeBet(
        Direction dir,
        uint256 amount,
        address referrer
    ) external;

    function settle(bool upWon) external;
    function claim() external;
    function emergencyRefund() external;

    function totalUpPool() external view returns (uint256);
    function totalDownPool() external view returns (uint256);
    function status() external view returns (Status);
    function marketCloseTime() external view returns (uint256);
    function pythFeedId() external view returns (bytes32);
    function entryPrice() external view returns (uint256);
}
