// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/OrderbookMarket.sol";
import "../../src/OracleResolver.sol";
import "./RedstonePayloadBuilder.sol";

/**
 * Base for tests that price something through RedStone.
 *
 * Keeps the mental model the suite already had with MockPyth: set a price, then
 * do things, and calls pick that price up. The difference is that a RedStone
 * price is not stored anywhere for a contract to read - it is signed data
 * appended to the calldata of each individual call - so `_setPrice` records
 * what the *next* call should carry rather than what the oracle now holds.
 *
 * That distinction is not cosmetic and is worth remembering when reading a
 * test: under Pyth a price set once stayed readable by anything until changed,
 * which is precisely the staleness the pull model exists to remove.
 */
abstract contract RedstoneTest is Test {
    /// Price the next call will carry, scaled by 1e8. Same scale the old
    /// MockPyth calls used via expo -8, so numbers carried over unchanged.
    uint256 internal rsPrice8dp;

    /// Feed the payloads are signed for.
    bytes32 internal rsFeedId = bytes32("PEPE");

    /// Signers per payload, matching production's 3-of-5 threshold.
    uint256 internal constant RS_SIGNERS = 3;

    /**
     * RedStone rejects payloads timestamped before mid-2022, and forge starts
     * tests at block.timestamp = 1. Every suite using this base therefore needs
     * a warp; doing it here means no test has to remember.
     */
    function _rsWarpToNow() internal {
        if (block.timestamp < 1_700_000_000) vm.warp(1_787_000_000);
    }

    function _setPrice(uint256 value8dp) internal {
        rsPrice8dp = value8dp;
    }

    function _setPrice(bytes32 feedId, uint256 value8dp) internal {
        rsFeedId   = feedId;
        rsPrice8dp = value8dp;
    }

    /// The payload a call should carry, at the currently set price.
    function _payload() internal view returns (bytes memory) {
        return RedstonePayloadBuilder.buildNow(rsFeedId, rsPrice8dp, RS_SIGNERS);
    }

    function _payload(uint256 value8dp) internal view returns (bytes memory) {
        return RedstonePayloadBuilder.buildNow(rsFeedId, value8dp, RS_SIGNERS);
    }

    // ── OrderbookMarket ───────────────────────────────────────────

    function _bet(
        OrderbookMarket mkt,
        address who,
        OrderbookMarket.Direction dir,
        uint256 amount,
        address referrer,
        uint256 expectedPrice,
        uint256 slippageBps
    ) internal returns (uint256 orderId) {
        (bool ok, bytes memory ret) =
            _tryBet(mkt, who, dir, amount, referrer, expectedPrice, slippageBps);
        require(ok, _rsReason(ret, "placeBet reverted"));
        orderId = abi.decode(ret, (uint256));
    }

    /**
     * Place a bet and hand back the outcome instead of reverting.
     *
     * Tests expecting a revert need this rather than vm.expectRevert: the
     * cheatcode arms the next call, but a low-level call that reverts is caught
     * here rather than propagating, so expectRevert would go unsatisfied and
     * the test would fail for a reason unrelated to what it is testing.
     */
    function _tryBet(
        OrderbookMarket mkt,
        address who,
        OrderbookMarket.Direction dir,
        uint256 amount,
        address referrer,
        uint256 expectedPrice,
        uint256 slippageBps
    ) internal returns (bool ok, bytes memory ret) {
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(
                OrderbookMarket.placeBet.selector,
                dir, amount, referrer, expectedPrice, slippageBps
            ),
            _payload()
        );
        vm.prank(who);
        (ok, ret) = address(mkt).call(callData);
    }

    /**
     * Place a bet carrying a payload deliberately stamped `ageSeconds` ago.
     *
     * Needed because every other helper stamps the payload at the current
     * block, so warping forward no longer makes a price stale the way it did
     * under Pyth - there a price sat on-chain and aged where it lay; here it is
     * minted fresh for each call. Staleness is now something a test has to
     * construct on purpose, which is itself the point of the pull model.
     */
    function _tryBetAged(
        OrderbookMarket mkt,
        address who,
        OrderbookMarket.Direction dir,
        uint256 amount,
        address referrer,
        uint256 expectedPrice,
        uint256 slippageBps,
        uint256 ageSeconds
    ) internal returns (bool ok, bytes memory ret) {
        // Backdating needs somewhere to go: forge starts tests at
        // block.timestamp = 1, and subtracting an age from that underflows.
        _rsWarpToNow();
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(
                OrderbookMarket.placeBet.selector,
                dir, amount, referrer, expectedPrice, slippageBps
            ),
            RedstonePayloadBuilder.build(
                rsFeedId, rsPrice8dp, (block.timestamp - ageSeconds) * 1000, RS_SIGNERS
            )
        );
        vm.prank(who);
        (ok, ret) = address(mkt).call(callData);
    }

    // ── OracleResolver ────────────────────────────────────────────

    function _record(OracleResolver resolver, address keeper, uint256 value8dp) internal {
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(OracleResolver.recordPrice.selector, rsFeedId),
            _payload(value8dp)
        );
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(resolver).call(callData);
        require(ok, _rsReason(ret, "recordPrice reverted"));
    }

    /// `spot8dp` is the live price the recorded TWAP is sanity-checked against.
    function _resolveMatch(
        OracleResolver resolver,
        address keeper,
        address market,
        uint256 matchId,
        uint256 spot8dp
    ) internal {
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMatch.selector, market, matchId),
            _payload(spot8dp)
        );
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(resolver).call(callData);
        require(ok, _rsReason(ret, "resolveOrderbookMatch reverted"));
    }

    function _resolveBatch(
        OracleResolver resolver,
        address keeper,
        address market,
        uint256 maxCount,
        uint256 spot8dp
    ) internal returns (uint256 settled) {
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(
                OracleResolver.resolveOrderbookMarketBatch.selector, market, maxCount
            ),
            _payload(spot8dp)
        );
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(resolver).call(callData);
        require(ok, _rsReason(ret, "resolveOrderbookMarketBatch reverted"));
        settled = abi.decode(ret, (uint256));
    }

    // ── ─────────────────────────────────────────────────────────

    /// Surfaces the callee's own revert string so a failure names its cause.
    function _rsReason(bytes memory ret, string memory fallbackMsg)
        internal pure returns (string memory)
    {
        if (ret.length < 68) return fallbackMsg;
        assembly { ret := add(ret, 0x04) }
        return string.concat(fallbackMsg, ": ", abi.decode(ret, (string)));
    }
}
