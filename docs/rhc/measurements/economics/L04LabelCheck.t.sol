// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Which kind of match the "PvP" scenario of contracts/test/L04FeeEconomics.t.sol creates.
// Needs a copy of that file next to this one in the scratch project (see README.md).
// Answer on the code of 2026-09-29: both matches are taken by the vault (lpMatch = 1),
// because setUp authorizes the market on the vault and the book is empty.

import "./L04FeeEconomics.t.sol";

contract L04LabelCheck is L04FeeEconomicsTest {
    function test_WhatThePvPTestActuallyMatches() public {
        vm.prank(alice);
        market.placeBet(OrderbookMarket.Direction.UP, STAKE, address(0), 1e18, 100);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.DOWN, STAKE, address(0), 1e18, 100);
        emit log_named_uint("match 1 lpMatch (1 = vault)", market.getMatch(1).lpMatch ? 1 : 0);
        emit log_named_uint("match 2 lpMatch (1 = vault)", market.getMatch(2).lpMatch ? 1 : 0);
        emit log_named_uint("matches created", market.nextMatchId() - 1);
    }
}
