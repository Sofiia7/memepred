// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/OrderbookMarket.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";

contract MockResolver {
    address public pyth;
    constructor(address _pyth) {
        pyth = _pyth;
    }
}

contract LiquidityPoolTest is Test {
    LiquidityPool   pool;
    GenesisNFT      genesisNFT;
    MockUSDC        usdc;
    OrderbookMarket market;

    address resolver;
    MockPyth pyth;
    address feeDistrib = makeAddr("feeDistrib");
    address multisig   = makeAddr("multisig");

    function setUp() public {
        pyth = new MockPyth();
        resolver = address(new MockResolver(address(pyth)));
        // ENTRY_PRICE = 1000 = 1000e12 or whatever. The test uses 1000 arbitrarily, so let's set it.
        // wait, we pass 1000 to placeBet expectedPrice.
        pyth.setPrice(bytes32("PEPE/USD"), 1000, 0); // Price = 1000 * 1e18
        
        usdc       = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(address(usdc), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarket(
            address(usdc),
            resolver,
            address(pool),
            feeDistrib,
            multisig,
            bytes32("PEPE/USD"),
            15 minutes
        );
        pool.setMarket(address(market));
    }

    // ── GENESIS NFT MINTING ───────────────────────────────
    function test_Genesis_NFT_Minted_For_First_20() public {
        for (uint i = 0; i < 20; i++) {
            address lp = makeAddr(string(abi.encodePacked("lp", vm.toString(i))));
            usdc.mint(lp, 50e6);
            vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
            vm.prank(lp); pool.deposit(50e6);
            assertEq(genesisNFT.balanceOf(lp), 1, "Genesis LP should have NFT");
        }

        // 21st doesn't get NFT
        address lp21 = makeAddr("lp21");
        usdc.mint(lp21, 50e6);
        vm.prank(lp21); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp21); pool.deposit(50e6);
        assertEq(genesisNFT.balanceOf(lp21), 0, "21st LP should not get NFT");
    }

    function test_Genesis_Count() public {
        address lp1 = makeAddr("lp1");
        usdc.mint(lp1, 100e6);
        vm.prank(lp1); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp1); pool.deposit(50e6);

        assertEq(pool.genesisCount(), 1);

        // Second deposit from same address doesn't increment
        vm.prank(lp1); pool.deposit(50e6);
        assertEq(pool.genesisCount(), 1);
    }

    // ── DEPOSIT & WITHDRAW ────────────────────────────────
    function test_Deposit_Success() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 100e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(50e6);

        assertEq(pool.totalDeposited(), 50e6);
        LiquidityPool.Provider memory p = pool.getProvider(lp);
        assertEq(p.deposit, 50e6);
        assertTrue(p.isGenesis);
    }

    function test_Deposit_Reverts_BelowMin() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 10e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp);
        vm.expectRevert("below min deposit");
        pool.deposit(10e6);
    }

    function test_Withdraw_Success() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 100e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(100e6);

        uint256 balBefore = usdc.balanceOf(lp);
        vm.prank(lp); pool.withdraw(50e6);
        assertEq(usdc.balanceOf(lp) - balBefore, 50e6);
        assertEq(pool.totalDeposited(), 50e6);
    }

    // ── POOL STATS ────────────────────────────────────────
    function test_GetPoolStats() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 100e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(100e6);

        (uint256 total, uint256 available, uint256 count, uint256 genesisLeft) = pool.getPoolStats();
        assertEq(total, 100e6);
        assertEq(available, 10e6); // 10% of 100 USDC
        assertEq(count, 1);
        assertEq(genesisLeft, 19);
    }

    // ── SET MARKET ────────────────────────────────────────
    function test_SetMarket_OnlyOnce() public {
        LiquidityPool pool2 = new LiquidityPool(address(usdc), address(genesisNFT));
        pool2.setMarket(address(market));

        vm.expectRevert("market already set");
        pool2.setMarket(address(market));
    }

    // ── LP MATCH FLOW ─────────────────────────────────────
    function test_LP_Match_And_Settle_LP_Wins() public {
        // LP deposits
        address lp = makeAddr("lp");
        usdc.mint(lp, 500e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(500e6);

        // Alice bets UP, matched by LP
        address alice = makeAddr("alice");
        usdc.mint(alice, 25e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        // DOWN won (LP took DOWN so LP wins)
        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 - 100); // exit < entry → DOWN won

        // Pool should have gained
        assertGt(pool.totalDeposited(), 500e6);
    }

    function test_LP_Match_And_Settle_LP_Loses() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 500e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(500e6);

        address alice = makeAddr("alice");
        usdc.mint(alice, 25e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        // UP won (LP took DOWN so LP loses)
        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 + 100); // exit > entry → UP won

        // Pool should have shrunk
        assertLt(pool.totalDeposited(), 500e6);
    }
}
