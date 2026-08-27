// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * OracleResolver after the move off Pyth.
 *
 * What actually changes: the price arrives as a signed calldata suffix instead
 * of as a bytes[] parameter that the contract pays Pyth to verify, and it
 * arrives at 8 decimals instead of Pyth's exponent-encoded form. Everything the
 * resolver does with a price afterwards - the history, the settleAt-anchored
 * TWAP, the spread guards, the unpriceable-match skip - is unchanged and stays
 * covered by OracleResolver.t.sol.
 *
 * So this file deliberately tests the seam and not the arithmetic behind it.
 */

import "forge-std/Test.sol";
import "../src/OracleResolver.sol";
import "./helpers/RedstonePayloadBuilder.sol";
import "./helpers/RedstoneHarness.sol";

contract OracleResolverRedstoneTest is Test {
    OracleResolverHarness resolver;

    address keeper   = makeAddr("keeper");
    address stranger = makeAddr("stranger");

    bytes32 constant PEPE = bytes32("PEPE");
    bytes32 constant DOGE = bytes32("DOGE");

    function setUp() public {
        resolver = new OracleResolverHarness();
        resolver.addKeeper(keeper);
        vm.warp(1_787_000_000);
    }

    /// Calls recordPrice with a signed price appended, the way the keeper will.
    function _recordPrice(bytes32 feedId, uint256 value8dp) internal returns (bool ok) {
        bytes memory payload = RedstonePayloadBuilder.buildNow(feedId, value8dp, 3);
        vm.prank(keeper);
        (ok,) = address(resolver).call(
            bytes.concat(abi.encodeWithSelector(OracleResolver.recordPrice.selector, feedId), payload)
        );
    }

    function _lastRecorded(bytes32 feedId) internal view returns (uint256 price) {
        uint256 n = resolver.historyLength(feedId);
        require(n > 0, "no price recorded");
        (price,) = resolver.priceHistory(feedId, n - 1);
    }

    // ── the price comes from the calldata, and nowhere else ───────

    function test_RecordsThePriceCarriedByTheCall() public {
        assertTrue(_recordPrice(PEPE, 392), "recordPrice reverted");

        assertEq(resolver.historyLength(PEPE), 1);
    }

    function test_RefusesACallCarryingNoSignedPrice() public {
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(
            abi.encodeWithSelector(OracleResolver.recordPrice.selector, PEPE)
        );

        assertFalse(ok, "a call with no signed price must not record one");
        assertEq(resolver.historyLength(PEPE), 0);
    }

    function test_StillKeeperOnly() public {
        bytes memory payload = RedstonePayloadBuilder.buildNow(PEPE, 392, 3);
        vm.prank(stranger);
        (bool ok,) = address(resolver).call(
            bytes.concat(abi.encodeWithSelector(OracleResolver.recordPrice.selector, PEPE), payload)
        );

        assertFalse(ok, "a stranger must not be able to write price history");
    }

    /// A payload for the wrong feed must not be able to price this one.
    function test_RefusesAPayloadForADifferentFeed() public {
        bytes memory dogePayload = RedstonePayloadBuilder.buildNow(DOGE, 8_922_446, 3);
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(
            bytes.concat(abi.encodeWithSelector(OracleResolver.recordPrice.selector, PEPE), dogePayload)
        );

        assertFalse(ok, "a DOGE payload must not record a PEPE price");
    }

    // ── decimals ──────────────────────────────────────────────────

    /**
     * The single most dangerous line in this migration. Pyth delivered a price
     * plus an exponent; RedStone delivers a plain integer scaled by 1e8. Every
     * strike, TWAP and settlement below the oracle works in 1e18, so a missing
     * conversion silently scales the whole protocol by 1e10 and every bet
     * settles against a number ten billion times too small.
     */
    function test_NormalisesEightDecimalsToEighteen() public {
        _recordPrice(DOGE, 8_922_446); // $0.08922446

        assertEq(_lastRecorded(DOGE), 0.08922446e18);
    }

    function test_NormalisesASubCentPrice() public {
        _recordPrice(PEPE, 392); // $0.00000392

        assertEq(_lastRecorded(PEPE), 0.00000392e18);
    }

    function test_NormalisesAPriceAboveADollar() public {
        _recordPrice(bytes32("ETH"), 190_231_516_800); // $1902.315168

        assertEq(_lastRecorded(bytes32("ETH")), 1902.315168e18);
    }

    // ── the oracle no longer costs anything to read ───────────────

    /**
     * Pyth charged a fee per update, paid from the resolver's own ETH, and a
     * resolver that ran dry stopped settling - one of the three failures that
     * took production down for two weeks. RedStone verifies signatures in our
     * own contract, so there is nothing to pay and no balance to run out of.
     */
    function test_RecordsWithoutAnyEtherAtAll() public {
        vm.deal(address(resolver), 0);

        assertTrue(_recordPrice(PEPE, 392), "recording must not need a balance");
        assertEq(address(resolver).balance, 0);
    }

    function test_NeedsNoPaymentFromTheCaller() public {
        bytes memory payload = RedstonePayloadBuilder.buildNow(PEPE, 392, 3);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        (bool ok,) = address(resolver).call{value: 0}(
            bytes.concat(abi.encodeWithSelector(OracleResolver.recordPrice.selector, PEPE), payload)
        );

        assertTrue(ok, "recording must not require a fee");
    }

    // ── signer threshold ──────────────────────────────────────────

    /// Three of five. One RedStone node must not be able to move a strike.
    function test_RejectsTooFewSigners() public {
        bytes memory payload = RedstonePayloadBuilder.buildNow(PEPE, 392, 2);
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(
            bytes.concat(abi.encodeWithSelector(OracleResolver.recordPrice.selector, PEPE), payload)
        );

        assertFalse(ok, "two signers must not be enough to write price history");
    }

    // ── history still behaves ─────────────────────────────────────

    function test_AppendsSuccessivePrices() public {
        _recordPrice(PEPE, 392);
        vm.warp(block.timestamp + 30);
        _recordPrice(PEPE, 400);

        assertEq(resolver.historyLength(PEPE), 2);
        assertEq(_lastRecorded(PEPE), 0.000004e18);
    }

    function test_KeepsFeedsApart() public {
        _recordPrice(PEPE, 392);
        _recordPrice(DOGE, 8_922_446);

        assertEq(resolver.historyLength(PEPE), 1);
        assertEq(resolver.historyLength(DOGE), 1);
    }
}
