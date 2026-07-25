// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Non-empty Pyth update payload for tests.
 *
 * Sprint 5.6 removed the bare `placeBet` overload and made
 * `placeBetWithPyth` reject an empty `priceUpdateData`, so every test that
 * places a bet has to hand it something. The bytes are never decoded: tests
 * run against MockPyth, whose `updatePriceFeeds` is a no-op and whose
 * `getUpdateFee` returns 0, so a single zero byte is enough to get past the
 * non-empty check. Price movement in tests is driven by `MockPyth.setPrice`,
 * exactly as before.
 */
function pythUpd() pure returns (bytes[] memory d) {
    d = new bytes[](1);
    d[0] = hex"00";
}
