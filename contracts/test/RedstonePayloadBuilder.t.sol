// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The payload builder has to be right before anything is built on it: every
 * oracle test in the suite will price its market through it, so a builder that
 * quietly produces a payload the consumer merely tolerates would make those
 * tests agree with themselves and prove nothing.
 *
 * So these tests check it against RedStone's own consumer code, not against a
 * reimplementation, and pin the byte layout against the real gateway payloads
 * in RedstoneFixture.
 */

import "forge-std/Test.sol";
import "@redstone-finance/evm-connector/contracts/mocks/RedstoneConsumerNumericMock.sol";
import "./helpers/RedstonePayloadBuilder.sol";
import "./helpers/RedstoneHarness.sol";
import "./RedstoneFixture.sol";

/// Mirrors production's 3-of-5 threshold; RedStone's mock defaults to 10.
contract MockPriceReader is RedstoneConsumerNumericMock {
    function getUniqueSignersThreshold() public view virtual override returns (uint8) {
        return 3;
    }

    function readPrice(bytes32 feedId) external view returns (uint256) {
        return getOracleNumericValueFromTxMsg(feedId);
    }
}

contract RedstonePayloadBuilderTest is Test {
    using RedstonePayloadBuilder for bytes32;

    MockPriceReader reader;

    bytes32 constant PEPE = bytes32("PEPE");
    bytes32 constant DOGE = bytes32("DOGE");

    function setUp() public {
        reader = new MockPriceReader();
        // RedstoneConsumerNumericMock refuses timestamps before mid-2022.
        vm.warp(1_787_000_000);
    }

    function _read(bytes32 feedId, bytes memory payload) internal view returns (bool ok, uint256 price) {
        bytes memory ret;
        (ok, ret) = address(reader)
            .staticcall(bytes.concat(abi.encodeWithSelector(MockPriceReader.readPrice.selector, feedId), payload));
        if (ok && ret.length == 32) price = abi.decode(ret, (uint256));
    }

    // ── the payload is genuinely valid ────────────────────────────

    function test_ConsumerAcceptsABuiltPayload() public view {
        (bool ok, uint256 price) = _read(PEPE, RedstonePayloadBuilder.buildNow(PEPE, 392, 3));

        assertTrue(ok, "RedStone's own consumer rejected our payload");
        assertEq(price, 392);
    }

    /// The whole point of the helper: any price on demand, which the captured
    /// live payloads cannot give us.
    function test_CanExpressAnyPrice() public view {
        uint256[4] memory prices = [uint256(1), 8_922_446, 392, 1e18];
        for (uint256 i = 0; i < prices.length; i++) {
            (bool ok, uint256 got) = _read(DOGE, RedstonePayloadBuilder.buildNow(DOGE, prices[i], 3));
            assertTrue(ok, "payload rejected");
            assertEq(got, prices[i]);
        }
    }

    function test_FeedIdIsRespected() public view {
        bytes memory payload = RedstonePayloadBuilder.buildNow(PEPE, 392, 3);

        (bool ok,) = _read(DOGE, payload);

        assertFalse(ok, "a PEPE payload must not answer for DOGE");
    }

    // ── the layout matches what the gateway really produces ───────

    /**
     * Three packages of 142 bytes plus a 14-byte tail. Checked against a real
     * gateway payload rather than against arithmetic, because an off-by-one in
     * the tail would still parse - the consumer walks backwards from the marker
     * - while silently shifting every offset.
     */
    function test_ByteLayoutMatchesTheLiveGateway() public pure {
        bytes memory built = RedstonePayloadBuilder.build(PEPE, 392, 1_787_853_570_000, 3);

        assertEq(built.length, RedstoneFixture.PEPE_PAYLOAD.length);
        assertEq(built.length, 440);
    }

    function test_PackageCountChangesLengthBy142() public pure {
        uint256 three = RedstonePayloadBuilder.build(PEPE, 1, 1_787_853_570_000, 3).length;
        uint256 four = RedstonePayloadBuilder.build(PEPE, 1, 1_787_853_570_000, 4).length;

        assertEq(four - three, 142);
    }

    /// The marker is how the consumer finds the end of the payload at all.
    function test_EndsWithTheRedstoneMarker() public pure {
        bytes memory built = RedstonePayloadBuilder.build(PEPE, 392, 1_787_853_570_000, 3);
        bytes memory live = RedstoneFixture.PEPE_PAYLOAD;

        for (uint256 i = 1; i <= 9; i++) {
            assertEq(built[built.length - i], live[live.length - i], "marker mismatch");
        }
    }

    // ── the threshold is real, not decorative ─────────────────────

    function test_RejectsFewerSignersThanTheThreshold() public view {
        (bool ok,) = _read(PEPE, RedstonePayloadBuilder.buildNow(PEPE, 392, 2));

        assertFalse(ok, "two signers must not satisfy a threshold of three");
    }

    function test_AcceptsMoreSignersThanTheThreshold() public view {
        (bool ok, uint256 price) = _read(PEPE, RedstonePayloadBuilder.buildNow(PEPE, 392, 5));

        assertTrue(ok, "five signers must satisfy a threshold of three");
        assertEq(price, 392);
    }

    /// Distinct keys, or "3 signatures" could be one signer three times and the
    /// threshold would mean nothing.
    function test_SignersAreDistinct() public pure {
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) {
                assertTrue(
                    RedstonePayloadBuilder.signerKey(i) != RedstonePayloadBuilder.signerKey(j),
                    "duplicate mock signer key"
                );
            }
        }
    }

    // ── timestamps ────────────────────────────────────────────────

    /**
     * The consumer must read back exactly the timestamp the builder wrote.
     * Staleness is deliberately not tested here: RedstoneConsumerNumericMock
     * overrides validateTimestamp to check only a lower bound, so a stale
     * payload is accepted and asserting otherwise would pass for the wrong
     * reason. The real window belongs to the production base and is covered in
     * RedstoneOracle.t.sol.
     */
    function test_ConsumerReadsBackTheTimestampWeWrote() public {
        uint256 tsMs = 1_787_853_570_000;
        bytes memory payload = RedstonePayloadBuilder.build(PEPE, 392, tsMs, 3);

        (bool ok, bytes memory ret) = address(reader)
            .staticcall(
                bytes.concat(abi.encodeWithSelector(reader.extractTimestampsAndAssertAllAreEqual.selector), payload)
            );

        assertTrue(ok, "timestamp extraction reverted");
        assertEq(abi.decode(ret, (uint256)), tsMs);
    }

    function test_BuildNowStampsTheCurrentBlockInMilliseconds() public {
        bytes memory payload = RedstonePayloadBuilder.buildNow(PEPE, 392, 3);

        (bool ok, bytes memory ret) = address(reader)
            .staticcall(
                bytes.concat(abi.encodeWithSelector(reader.extractTimestampsAndAssertAllAreEqual.selector), payload)
            );

        assertTrue(ok, "timestamp extraction reverted");
        // Milliseconds, not seconds: RedStone timestamps are ms and a payload
        // stamped in seconds reads as 1970 and fails every staleness check.
        assertEq(abi.decode(ret, (uint256)), block.timestamp * 1000);
    }
}
