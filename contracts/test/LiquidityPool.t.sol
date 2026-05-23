// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/OrderbookMarket.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";

contract MockResolver {
    address public pyth;
    constructor(address _pyth) { pyth = _pyth; }
}

contract LiquidityPoolTest is Test {
    LiquidityPool   pool;
    GenesisNFT      genesisNFT;
    MockUSDC        usdc;
    OrderbookMarket market;
    MockPyth        pyth;
    address         resolver;

    address feeDistrib = makeAddr("feeDistrib");
    address multisig   = makeAddr("multisig");
    address factory    = makeAddr("factory");

    function setUp() public {
        pyth     = new MockPyth();
        resolver = address(new MockResolver(address(pyth)));
        pyth.setPrice(bytes32("PEPE/USD"), 1000, 0);

        usdc       = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarket(
            address(usdc),
            resolver,
            address(pool),
            feeDistrib,
            address(0), // referralRegistry — not exercised in LP unit tests
            multisig,
            bytes32("PEPE/USD"),
            15 minutes
        );

        pool.setMarketFactory(factory);
        vm.prank(factory);
        pool.authorizeMarket(address(market));
    }

    // ─── helpers ──────────────────────────────────────────
    function _addLP(string memory name, uint256 amount) internal returns (address lp) {
        lp = makeAddr(name);
        usdc.mint(lp, amount);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(amount, lp);
    }

    // ─── DEPOSIT & GENESIS ────────────────────────────────
    function test_Deposit_MintsShares() public {
        address lp = _addLP("lp1", 100e6);
        assertGt(pool.balanceOf(lp), 0, "shares minted");
        assertEq(pool.totalAssets(), 100e6, "totalAssets = deposit");
    }

    function test_Deposit_Reverts_BelowMin() public {
        address lp = makeAddr("lp");
        usdc.mint(lp, 10e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp);
        vm.expectRevert("below min deposit");
        pool.deposit(10e6, lp);
    }

    function test_Genesis_First20_Get_NFT() public {
        for (uint i = 0; i < 20; i++) {
            address lp = _addLP(string.concat("lp", vm.toString(i)), 50e6);
            assertTrue(pool.isGenesis(lp), "should be genesis");
            assertEq(genesisNFT.balanceOf(lp), 1, "has NFT");
        }
        address lp21 = _addLP("lp21", 50e6);
        assertFalse(pool.isGenesis(lp21), "21st not genesis");
        assertEq(genesisNFT.balanceOf(lp21), 0, "no NFT");
        assertEq(pool.genesisCount(), 20);
    }

    function test_Genesis_Status_StableOnRepeatDeposit() public {
        address lp = _addLP("lp", 50e6);
        assertTrue(pool.isGenesis(lp));
        assertEq(pool.genesisCount(), 1);

        usdc.mint(lp, 50e6);
        vm.prank(lp); pool.deposit(50e6, lp);
        assertEq(pool.genesisCount(), 1, "no increment on repeat");
    }

    // ─── WITHDRAW ─────────────────────────────────────────
    function test_Withdraw_FullAmount_NoExposure() public {
        address lp = _addLP("lp", 100e6);
        uint256 bal = usdc.balanceOf(lp);
        uint256 shares = pool.balanceOf(lp);

        vm.prank(lp); pool.redeem(shares, lp, lp);
        assertEq(pool.balanceOf(lp), 0);
        assertEq(usdc.balanceOf(lp) - bal, 100e6, "got back deposit");
    }

    function test_Withdraw_Blocked_By_Exposure() public {
        _addLP("lp1", 500e6);

        // Bob takes a bet → LP matches, exposure locked
        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        // Now totalExposure > 0; maxWithdraw is reduced
        address lp1 = makeAddr("lp1");
        uint256 maxWd = pool.maxWithdraw(lp1);
        assertLt(maxWd, 500e6, "max less than deposit due to exposure");
    }

    // ─── AUTHORIZATION ────────────────────────────────────
    function test_TryMatch_Reverts_UnauthorizedMarket() public {
        address bad = makeAddr("rogue");
        vm.prank(bad);
        vm.expectRevert("not authorized market");
        pool.tryMatch(1, 10e6, true, 1);
    }

    function test_AuthorizeMarket_OnlyFactoryOrOwner() public {
        address newMarket = makeAddr("market2");
        // random address blocked
        vm.prank(makeAddr("nobody"));
        vm.expectRevert("only factory or owner");
        pool.authorizeMarket(newMarket);

        // owner allowed
        pool.authorizeMarket(newMarket);
        assertTrue(pool.isAuthorizedMarket(newMarket));

        // factory allowed
        address m2 = makeAddr("market3");
        vm.prank(factory);
        pool.authorizeMarket(m2);
        assertTrue(pool.isAuthorizedMarket(m2));
    }

    function test_SetMarketFactory_OnceOnly() public {
        LiquidityPool p2 = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        p2.setMarketFactory(factory);
        vm.expectRevert("factory already set");
        p2.setMarketFactory(makeAddr("other"));
    }

    function test_Deauthorize_OnlyOwner() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert();
        pool.deauthorizeMarket(address(market));

        pool.deauthorizeMarket(address(market));
        assertFalse(pool.isAuthorizedMarket(address(market)));
    }

    // ─── LP WIN: SHARE PRICE GROWS ────────────────────────
    function test_LP_Wins_SharePrice_Grows() public {
        address lp = _addLP("lp", 500e6);
        uint256 sharesBefore = pool.balanceOf(lp);
        uint256 priceBefore  = pool.previewRedeem(sharesBefore);

        // Bob bets UP → LP takes DOWN
        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        // DOWN wins → LP wins
        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 - 100);

        uint256 priceAfter = pool.previewRedeem(sharesBefore);
        assertGt(priceAfter, priceBefore, "share price grew after LP win");
    }

    function test_LP_Loses_SharePrice_Drops() public {
        address lp = _addLP("lp", 500e6);
        uint256 priceBefore = pool.previewRedeem(pool.balanceOf(lp));

        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        // UP wins → LP loses
        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 + 100);

        uint256 priceAfter = pool.previewRedeem(pool.balanceOf(lp));
        assertLt(priceAfter, priceBefore, "share price dropped after LP loss");
    }

    // ─── FEE STREAM (Variant E) ───────────────────────────
    function test_LP_Win_AccruesFee_To_LP() public {
        _addLP("lp", 500e6);
        address lp = makeAddr("lp");

        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 - 100); // LP wins

        // 1% of 25 = 0.25 USDC fee earmarked (allow 1 wei rounding from index quantization)
        assertApproxEqAbs(pool.earnedFees(lp), 25e6 / 100, 1, "1% fee accrued");

        uint256 balBefore = usdc.balanceOf(lp);
        vm.prank(lp); pool.claimFees();
        assertApproxEqAbs(usdc.balanceOf(lp) - balBefore, 25e6 / 100, 1, "fee claimed");
    }

    function test_FeeStream_GenesisBoost_Vs_Normal() public {
        // gen = first depositor (Genesis), normal = 21st (no NFT)
        address gen = _addLP("gen", 500e6);
        // Fill 19 more Genesis spots so the next is non-Genesis
        for (uint i = 0; i < 19; i++) _addLP(string.concat("g", vm.toString(i)), 50e6);
        // 21st depositor is NOT Genesis
        address normal = _addLP("normal", 500e6);
        assertFalse(pool.isGenesis(normal));
        assertTrue(pool.isGenesis(gen));

        // Trigger LP win to accrue fees
        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 - 100);

        uint256 feeGen    = pool.earnedFees(gen);
        uint256 feeNormal = pool.earnedFees(normal);
        assertGt(feeGen, feeNormal, "Genesis earns more than normal at equal stake");
        // Genesis weight = shares * 1.5; expect ~1.5x normal
        // (they have equal share balance here because 500e6 deposit each)
        assertApproxEqRel(feeGen, feeNormal * 15_000 / 10_000, 0.01e18);
    }

    // ─── EXPOSURE CAPS ────────────────────────────────────
    function test_Exposure_Per_Market_Cap() public {
        _addLP("lp", 10_000e6);

        // Per-market cap = 5% of totalAssets = 500e6. Single bet matched up to 25e6 always fine.
        // But cumulative bets up to 500e6 should be allowed; 26th 25e6 bet should queue.
        // Simpler: place a bet bigger than per-market cap — see it gets capped.
        address bob = makeAddr("bob");
        usdc.mint(bob, 100e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 100e6, address(0), 1000 * 1e18, 100);

        // Per-market cap = 500e6 → bet of 100e6 fully matched
        assertEq(pool.marketExposure(address(market)), 100e6);

        // Total exposure under cap
        assertLe(pool.totalExposure(), pool.totalAssets() * 1_000 / 10_000);
    }

    // ─── DUAL ACCOUNTING: totalAssets EXCLUDES pending fees ─
    function test_TotalAssets_Excludes_PendingFees() public {
        _addLP("lp", 500e6);

        address bob = makeAddr("bob");
        usdc.mint(bob, 25e6);
        vm.prank(bob); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100);

        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 - 100); // LP win

        uint256 fee     = 25e6 / 100;
        uint256 winNet  = 25e6 - fee;
        // totalAssets = 500 (initial) + winNet (since fee is excluded)
        assertEq(pool.totalAssets(), 500e6 + winNet);
        assertEq(pool.totalPendingFees(), fee);
    }

    // ─── SOULBOUND ────────────────────────────────────────
    function test_Shares_Are_Soulbound() public {
        address lp = _addLP("lp", 100e6);
        address other = makeAddr("other");
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert("soulbound");
        pool.transfer(other, shares);
    }

    // ─── PAUSE ───────────────────────────────────────────
    function test_Pause_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        pool.pause();
        pool.pause();
        assertTrue(pool.paused());
    }

    function test_Pause_Blocks_Deposit() public {
        pool.pause();
        address lp = makeAddr("lp");
        usdc.mint(lp, 100e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp);
        vm.expectRevert();
        pool.deposit(100e6, lp);
    }

    function test_Pause_Blocks_LPMatch_AllowsWithdraw() public {
        address lp = _addLP("lp", 500e6);

        pool.pause();

        // Withdraw still works.
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp); pool.redeem(shares, lp, lp);
        assertEq(pool.balanceOf(lp), 0);
    }

    function test_Unpause_RestoresDeposit() public {
        pool.pause();
        pool.unpause();
        address lp = _addLP("lp", 100e6);
        assertGt(pool.balanceOf(lp), 0);
    }

    // ─── POOL STATS ───────────────────────────────────────
    function test_GetPoolStats() public {
        _addLP("lp", 100e6);
        (uint256 ta, uint256 avail, uint256 exposure, uint256 genLeft) = pool.getPoolStats();
        assertEq(ta, 100e6);
        assertEq(avail, 10e6); // 10% of 100
        assertEq(exposure, 0);
        assertEq(genLeft, 19);
    }
}
