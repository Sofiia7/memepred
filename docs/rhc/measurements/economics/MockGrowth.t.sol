// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "./mocks/MockUniswapV3Pool.sol";

/// How the stand-in pool's observe() cost grows with the records pushTick appends
/// (MockUniswapV3Pool.sol:143-162 loops over all of them). Run with --isolate.
contract MockGrowthTest is Test {
    function _gasFor(uint256 records) internal returns (uint256) {
        vm.warp(1_790_000_000);
        MockUniswapV3Pool p = new MockUniswapV3Pool(address(1), address(2), 10000);
        uint32 t = uint32(block.timestamp) - uint32(records * 20) - 400;
        for (uint256 i = 0; i < records; i++) { p.pushTick(t, int24(int256(i % 7))); t += 20; }
        uint32[] memory ago = new uint32[](3);
        ago[0] = 180; ago[1] = 60; ago[2] = 0;
        p.observe(ago);
        return vm.lastCallGas().gasTotalUsed;
    }
    function test_ObserveGasGrowsPerRecord() public {
        uint256[5] memory ns = [uint256(4), 16, 100, 500, 2000];
        for (uint256 i = 0; i < ns.length; i++) {
            emit log_named_uint(string.concat("observe(3 pts) gas at records=", vm.toString(ns[i])), _gasFor(ns[i]));
        }
    }
}
