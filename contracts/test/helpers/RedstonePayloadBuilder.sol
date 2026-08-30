// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/**
 * Builds RedStone payloads inside Solidity tests.
 *
 * This is the RedStone equivalent of MockPyth.setPrice: the rest of the suite
 * needs to price a market at an arbitrary number and see what the contracts do,
 * and RedStone prices only exist as signed calldata. The live payloads in
 * RedstoneFixture prove the integration is real, but they carry whatever the
 * market happened to be doing when they were captured, so they cannot express
 * "now the price is exactly double the strike".
 *
 * Signs with the mock signer set RedStone's own AuthorisedMockSignersBase
 * authorises, which are the standard Anvil accounts.
 *
 * Payload layout, taken from RedstoneConstants and the extraction code in
 * RedstoneConsumerBase, for one data point per package:
 *
 *   package  = feedId(32) value(32) timestamp(6) pointsCount(3) valueSize(4) sig(65)   = 142
 *   payload  = package... unsignedMetadata() metadataSize(3) packagesCount(2) marker(9)
 *
 * The signed message is the package without its signature, hashed with a plain
 * keccak256 - no EIP-191 prefix, which is what RedstoneConsumerBase recovers
 * against. Sanity check on the sizes: three packages plus the 14-byte tail is
 * 440 bytes, exactly the length of the real gateway payloads in RedstoneFixture.
 */
library RedstonePayloadBuilder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// 0x000002ed57011e0000 - marks the end of a RedStone payload.
    bytes9 private constant REDSTONE_MARKER = 0x000002ed57011e0000;

    /// One data point per package, values in a full 32-byte slot.
    uint24 private constant DATA_POINTS_COUNT = 1;
    uint32 private constant VALUE_BYTE_SIZE = 32;

    /**
     * The standard Anvil keys, whose addresses are the mock signers
     * AuthorisedMockSignersBase accepts. Index 0 is Anvil account #0.
     *
     * Deliberately not a storage constant array: Solidity has no constant
     * arrays, and a test helper that needs a constructor would infect every
     * test that uses it.
     */
    function signerKey(uint256 index) internal pure returns (uint256) {
        if (index == 0) return 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        if (index == 1) return 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        if (index == 2) return 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
        if (index == 3) return 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
        if (index == 4) return 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
        revert("RedstonePayloadBuilder: no such mock signer");
    }

    /**
     * @param feedId       e.g. bytes32("PEPE")
     * @param value8dp     price scaled by 1e8, the way RedStone publishes them
     * @param timestampMs  package timestamp in MILLISECONDS, as RedStone uses
     * @param signerCount  how many distinct mock signers sign it
     */
    function build(bytes32 feedId, uint256 value8dp, uint256 timestampMs, uint256 signerCount)
        internal
        pure
        returns (bytes memory payload)
    {
        for (uint256 i = 0; i < signerCount; i++) {
            payload = bytes.concat(payload, _package(feedId, value8dp, timestampMs, signerKey(i)));
        }
        // Order matters and is not the one the field names suggest: the count
        // comes before the metadata size. RedstoneConsumerBase finds the
        // metadata size by loading 32 bytes at calldatasize()-41 and taking the
        // low 3 bytes, which lands on [len-12, len-9) - so the packages count
        // sits at [len-14, len-12), before it. Getting this backwards keeps the
        // payload exactly the same length and makes every offset after it wrong,
        // which surfaces as an arithmetic panic deep inside their parser.
        payload = bytes.concat(
            payload,
            bytes2(uint16(signerCount)), // data packages count
            bytes3(0), // unsigned metadata byte size (none)
            REDSTONE_MARKER
        );
    }

    /// Convenience: a payload timestamped at the current block, which is what
    /// almost every test wants.
    function buildNow(bytes32 feedId, uint256 value8dp, uint256 signerCount) internal view returns (bytes memory) {
        return build(feedId, value8dp, block.timestamp * 1000, signerCount);
    }

    function _package(bytes32 feedId, uint256 value8dp, uint256 timestampMs, uint256 privateKey)
        private
        pure
        returns (bytes memory)
    {
        // Value size before count, not after. Their own constant spells the
        // order out read backwards from the end of the package:
        // TIMESTAMP_NEGATIVE_OFFSET... = SIG_BS + DATA_POINTS_COUNT_BS +
        // DATA_POINT_VALUE_BYTE_SIZE_BS + STANDARD_SLOT_BS. Swapping the two
        // leaves the package the right length and the payload unparseable.
        bytes memory signedMessage =
            abi.encodePacked(feedId, value8dp, uint48(timestampMs), VALUE_BYTE_SIZE, DATA_POINTS_COUNT);

        // Plain keccak256, no "\x19Ethereum Signed Message" prefix: this is what
        // RedstoneConsumerBase hashes and recovers against.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, keccak256(signedMessage));

        return bytes.concat(signedMessage, r, s, bytes1(v));
    }
}
