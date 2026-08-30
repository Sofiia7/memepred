// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Proves our contracts can consume live RedStone data.
 *
 * Why we are on RedStone at all: Pyth's Core upgrade put every memecoin feed
 * behind a $500/month plan on 2026-08-26. A key from their free tier serves
 * BTC, ETH and DOGE and answers 403 "not entitled" for PEPE, BRETT, DEGEN,
 * BONK, WIF and every other feed this product exists to price. RedStone serves
 * all of them from a public gateway with no key at all.
 *
 * The payloads in RedstoneFixture are real: captured from that gateway and
 * signed by the actual authorised signers hardcoded in
 * PrimaryProdDataServiceConsumerBase. So these tests exercise real signature
 * recovery, the real 3-of-5 threshold and the real calldata layout. Mock
 * signers would only prove we can talk to ourselves.
 */

import "forge-std/Test.sol";
import "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";
import "./RedstoneFixture.sol";

/// Minimal consumer: the shape OracleResolver will take.
contract PriceReader is PrimaryProdDataServiceConsumerBase {
    /// Reads the price out of the payload appended to this call's calldata.
    function readPrice(bytes32 feedId) external view returns (uint256) {
        return getOracleNumericValueFromTxMsg(feedId);
    }
}

contract RedstoneOracleTest is Test {
    PriceReader reader;

    function setUp() public {
        reader = new PriceReader();
    }

    /// Appends a RedStone payload to the calldata of readPrice, the way the
    /// keeper and the frontend will have to.
    function _readWithPayload(bytes32 feedId, bytes memory payload) internal view returns (bool ok, uint256 price) {
        bytes memory callData =
            abi.encodePacked(abi.encodeWithSelector(PriceReader.readPrice.selector, feedId), payload);
        bytes memory ret;
        (ok, ret) = address(reader).staticcall(callData);
        if (ok && ret.length == 32) price = abi.decode(ret, (uint256));
    }

    function test_ReadsLivePepePrice() public {
        vm.warp(RedstoneFixture.PEPE_TIMESTAMP_MS / 1000);

        (bool ok, uint256 price) = _readWithPayload(bytes32("PEPE"), RedstoneFixture.PEPE_PAYLOAD);

        assertTrue(ok, "payload rejected");
        assertEq(price, RedstoneFixture.PEPE_VALUE_8DP);
    }

    // The feed Pyth's free tier does serve, kept as a control: if only PEPE
    // worked we would suspect the fixture, not the integration.
    function test_ReadsLiveDogePrice() public {
        vm.warp(RedstoneFixture.DOGE_TIMESTAMP_MS / 1000);

        (bool ok, uint256 price) = _readWithPayload(bytes32("DOGE"), RedstoneFixture.DOGE_PAYLOAD);

        assertTrue(ok, "payload rejected");
        assertEq(price, RedstoneFixture.DOGE_VALUE_8DP);
    }

    /// Prices arrive scaled by 1e8, not 1e18. Everything downstream of the
    /// oracle in this protocol works in 1e18, so the conversion is a real step
    /// and not a detail - getting it wrong scales every strike by 1e10.
    function test_PriceIsEightDecimals() public {
        vm.warp(RedstoneFixture.DOGE_TIMESTAMP_MS / 1000);

        (, uint256 price) = _readWithPayload(bytes32("DOGE"), RedstoneFixture.DOGE_PAYLOAD);

        // DOGE is around $0.09, so 8dp puts it in the millions and 18dp would
        // put it near 1e17. This pins which one we actually get.
        assertGt(price, 1e6);
        assertLt(price, 1e8);
    }

    function test_RejectsCallWithNoPayload() public {
        vm.warp(RedstoneFixture.PEPE_TIMESTAMP_MS / 1000);

        (bool ok,) = address(reader).staticcall(abi.encodeWithSelector(PriceReader.readPrice.selector, bytes32("PEPE")));

        assertFalse(ok, "a call with no signed price must not produce one");
    }

    /// The staleness guard. RedStone's default window is 3 minutes back and 1
    /// minute forward; a bet or a settlement must not be priced by a payload
    /// from hours ago that someone kept in their pocket.
    function test_RejectsStalePayload() public {
        vm.warp(RedstoneFixture.PEPE_TIMESTAMP_MS / 1000 + 4 minutes);

        (bool ok,) = _readWithPayload(bytes32("PEPE"), RedstoneFixture.PEPE_PAYLOAD);

        assertFalse(ok, "payload older than the window must be rejected");
    }

    function test_AcceptsPayloadInsideTheWindow() public {
        vm.warp(RedstoneFixture.PEPE_TIMESTAMP_MS / 1000 + 2 minutes);

        (bool ok, uint256 price) = _readWithPayload(bytes32("PEPE"), RedstoneFixture.PEPE_PAYLOAD);

        assertTrue(ok, "payload inside the window must be accepted");
        assertEq(price, RedstoneFixture.PEPE_VALUE_8DP);
    }

    /// A payload for one feed must not answer a question about another. Without
    /// this the keeper could settle a PEPE market against a DOGE price.
    function test_RejectsPayloadForADifferentFeed() public {
        vm.warp(RedstoneFixture.PEPE_TIMESTAMP_MS / 1000);

        (bool ok,) = _readWithPayload(bytes32("DOGE"), RedstoneFixture.PEPE_PAYLOAD);

        assertFalse(ok, "a PEPE payload must not price DOGE");
    }

    /// Three of five signers is the threshold the base contract enforces, and
    /// it is the security property we are relying on: no single RedStone node
    /// can move a strike on its own.
    function test_ThresholdIsThreeOfFive() public view {
        assertEq(reader.getUniqueSignersThreshold(), 3);
    }
}
