// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/MarketFactory.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/PythUpd.sol";
import "./mocks/MockPyth.sol";

contract MockResolver {
    address public pyth;
    constructor(address _pyth) { pyth = _pyth; }
}

/// @notice End-to-end wiring tests covering B2/B3/B4/B5 integrations:
///         - MarketFactory.createMarket authorizes market on LP, FeeDistributor, ReferralRegistry.
///         - OrderbookMarket.placeBet registers referral via the registry.
///         - OrderbookMarket._settleOrder pushes fee through FeeDistributor split.
contract IntegrationTest is Test {
    MockUSDC         usdc;
    MockPyth         pyth;
    address          resolver;
    GenesisNFT       genesisNFT;
    LiquidityPool    pool;
    FeeDistributor   feeDist;
    ReferralRegistry refReg;
    MarketFactory    factory;
    OrderbookMarket  market;

    address treasury = makeAddr("treasury");
    address lpSink   = makeAddr("lpSink");
    address nftPool  = makeAddr("nftPool");
    address multisig = makeAddr("multisig");

    bytes32 constant FEED = bytes32("PEPE/USD");

    function setUp() public {
        usdc     = new MockUSDC();
        pyth     = new MockPyth();
        resolver = address(new MockResolver(address(pyth)));
        pyth.setPrice(FEED, 1000, 0);

        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        feeDist = new FeeDistributor(address(usdc), treasury, lpSink, nftPool);
        refReg  = new ReferralRegistry();

        factory = new MarketFactory(
            address(usdc),
            resolver,
            address(feeDist),
            address(refReg),
            multisig,
            address(pool)
        );

        pool   .setMarketFactory(address(factory));
        feeDist.setMarketFactory(address(factory));
        refReg .setMarketFactory(address(factory));

        factory.addFeed(FEED);

        // Enable a non-zero fee BEFORE creating the market, so the distribute
        // path is exercised. Order matters now: the fee lives on the factory
        // and a market snapshots it at creation, which is what keeps an open
        // position settling on the terms it was opened under.
        factory.proposeNewFee(100); // 1%
        vm.warp(block.timestamp + 48 hours + 1);
        factory.applyNewFee();

        // owner-path createMarket (no resolver prank needed)
        market = OrderbookMarket(factory.createMarket(FEED, 15 minutes));

        // The 48h timelock warp above staled the oracle price set earlier
        // in this function — refresh it so every test starts with a fresh
        // price baseline regardless of the timelock simulation.
        pyth.setPrice(FEED, 1000, 0);
    }

    // ── B2/B5: createMarket authorizes everywhere ────────
    function test_MarketAuthorizedOn_All_Three() public view {
        assertTrue(pool   .isAuthorizedMarket(address(market)),  "LP authorized");
        assertTrue(feeDist.isAuthorizedMarket(address(market)),  "FeeDist authorized");
        assertTrue(refReg .authorizedMarkets (address(market)),  "RefReg authorized");
    }

    // ── B5: placeBet records referral ────────────────────
    function test_PlaceBet_RegistersReferral() public {
        address alice = makeAddr("alice");
        address bob   = makeAddr("bob"); // referrer

        usdc.mint(alice, 100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP, 25e6, bob, 1000 * 1e18, 100, pythUpd());

        assertEq(refReg.referrerOf(alice), bob, "referral recorded on first bet");
    }

    function test_PlaceBet_ReferralStable_OnSecondBet() public {
        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        address eve   = makeAddr("eve");

        usdc.mint(alice, 100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP, 25e6, bob, 1000 * 1e18, 100, pythUpd());

        // Second bet attempts a different referrer — registry must keep the first.
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP, 25e6, eve, 1000 * 1e18, 100, pythUpd());

        assertEq(refReg.referrerOf(alice), bob, "first referrer wins");
    }

    function test_PlaceBet_ZeroReferrer_Skips_Register() public {
        address alice = makeAddr("alice");

        usdc.mint(alice, 100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP, 25e6, address(0), 1000 * 1e18, 100, pythUpd());

        assertEq(refReg.referrerOf(alice), address(0));
    }

    // ── B4: end-to-end fee distribution via market settle ─
    function test_Settle_PushesFee_ToFeeDistributor_Split() public {
        // LP funds vault.
        address lp = makeAddr("lp");
        usdc.mint(lp, 1000e6);
        vm.prank(lp); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp); pool.deposit(1000e6, lp);

        // Alice (UP) with referrer = bob ; LP takes DOWN.
        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        usdc.mint(alice, 100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP, 25e6, bob, 1000 * 1e18, 100, pythUpd());

        // UP wins → user wins → settle pushes fee.
        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 + 100);

        // Fee = 1% of (25 * 2) = 0.5 USDC.
        // Referrer share: 40% of fee = 0.2 USDC; remaining 0.3 split 20/20/20 of 60 ≈ 0.1 each.
        uint256 expectedFee = (50e6 * 100) / 10_000; // 500_000
        uint256 expectedRef = (expectedFee * 4000) / 10_000; // 200_000

        assertEq(feeDist.referralBalance(bob), expectedRef, "ref 40%");
        // Treasury / lpSink / nftPool each get ~ (300_000 / 3) = 100_000 (one absorbs remainder)
        uint256 total = usdc.balanceOf(treasury) + usdc.balanceOf(lpSink) + usdc.balanceOf(nftPool);
        assertEq(total + feeDist.referralBalance(bob), expectedFee, "fee fully accounted");
    }

    function test_Settle_NoReferrer_FullSplitToSinks() public {
        address alice = makeAddr("alice");
        address charlie = makeAddr("charlie");
        usdc.mint(alice,   100e6);
        usdc.mint(charlie, 100e6);
        vm.prank(alice);   usdc.approve(address(market), type(uint256).max);
        vm.prank(charlie); usdc.approve(address(market), type(uint256).max);

        // PvP match: Alice UP, Charlie DOWN, no referrer.
        vm.prank(alice);
        market.placeBetWithPyth(OrderbookMarket.Direction.UP,   25e6, address(0), 1000 * 1e18, 100, pythUpd());
        vm.prank(charlie);
        market.placeBetWithPyth(OrderbookMarket.Direction.DOWN, 25e6, address(0), 1000 * 1e18, 100, pythUpd());

        vm.warp(block.timestamp + 15 minutes + 1);
        vm.prank(resolver);
        market.settleMatch(1, 1000 * 1e18 + 100); // UP wins → Alice wins

        uint256 fee = (50e6 * 100) / 10_000; // 500_000
        uint256 total = usdc.balanceOf(treasury) + usdc.balanceOf(lpSink) + usdc.balanceOf(nftPool);
        assertEq(total, fee, "all fee goes to sinks");
    }
}
