// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/MarketFactory.sol";
import "../src/LiquidityPool.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/GenesisNFT.sol";
import "../src/OrderbookMarket.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";

contract MockResolver {
    address public pyth;
    constructor(address _pyth) { pyth = _pyth; }
}

contract MarketFactoryTest is Test {
    MockUSDC      usdc;
    MockPyth      pyth;
    address       resolver;
    GenesisNFT    genesisNFT;
    LiquidityPool pool;
    MarketFactory factory;

    address treasury = makeAddr("treasury");
    address multisig = makeAddr("multisig");
    address keeper   = makeAddr("keeper");

    bytes32 constant FEED_PEPE = bytes32("PEPE/USD");
    bytes32 constant FEED_DOGE = bytes32("DOGE/USD");

    function setUp() public {
        usdc       = new MockUSDC();
        pyth       = new MockPyth();
        resolver   = address(new MockResolver(address(pyth)));
        pyth.setPrice(FEED_PEPE, 1000, 0);
        pyth.setPrice(FEED_DOGE, 2000, 0);

        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        // Deploy real FeeDistributor + ReferralRegistry so factory can authorize them.
        FeeDistributor   feeDist   = new FeeDistributor(address(usdc), treasury, treasury, treasury);
        ReferralRegistry refReg    = new ReferralRegistry();

        factory = new MarketFactory(
            address(usdc),
            resolver,
            address(feeDist),
            address(refReg),
            multisig,
            address(pool)
        );

        pool.setMarketFactory(address(factory));
        feeDist.setMarketFactory(address(factory));
        refReg.setMarketFactory(address(factory));
        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);
    }

    // ── feed management ───────────────────────────────────
    function test_AddFeed_OnlyOwner() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert();
        factory.addFeed(bytes32("X"));
    }

    function test_RemoveFeed_OnlyOwner() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert();
        factory.removeFeed(FEED_PEPE);

        factory.removeFeed(FEED_PEPE);
        assertFalse(factory.allowedFeeds(FEED_PEPE));
    }

    function test_GetAllFeedIds() public view {
        bytes32[] memory ids = factory.getAllFeedIds();
        assertEq(ids.length, 2);
    }

    // ── createMarket ──────────────────────────────────────
    function test_CreateMarket_AuthorizesLP() public {
        vm.prank(resolver);
        address m = factory.createMarket(FEED_PEPE, 15 minutes);

        assertTrue(pool.isAuthorizedMarket(m), "market authorized on LP");
        assertEq(factory.getActiveMarkets(FEED_PEPE).length, 1);
        assertEq(factory.getActiveMarkets(FEED_PEPE)[0], m);
    }

    function test_CreateMarket_Reverts_UnauthorizedCaller() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert("unauthorized");
        factory.createMarket(FEED_PEPE, 15 minutes);
    }

    function test_CreateMarket_Reverts_FeedNotWhitelisted() public {
        vm.prank(resolver);
        vm.expectRevert("feed not whitelisted");
        factory.createMarket(bytes32("UNKNOWN"), 15 minutes);
    }

    function test_CreateMarket_Reverts_DurationNotAllowed() public {
        vm.prank(resolver);
        vm.expectRevert("duration not allowed");
        factory.createMarket(FEED_PEPE, 7 minutes); // not in allowedDurations
    }

    function test_CreateMarket_Owner_Bypass() public {
        // Owner can also create — used by deploy / admin
        address m = factory.createMarket(FEED_PEPE, 1 hours);
        assertTrue(pool.isAuthorizedMarket(m));
    }

    function test_CreateMarket_Multiple_SharePool() public {
        vm.startPrank(resolver);
        address m1 = factory.createMarket(FEED_PEPE, 5 minutes);
        address m2 = factory.createMarket(FEED_PEPE, 15 minutes);
        address m3 = factory.createMarket(FEED_DOGE, 1 hours);
        vm.stopPrank();

        assertTrue(pool.isAuthorizedMarket(m1));
        assertTrue(pool.isAuthorizedMarket(m2));
        assertTrue(pool.isAuthorizedMarket(m3));
        assertEq(factory.getActiveMarkets(FEED_PEPE).length, 2);
        assertEq(factory.getActiveMarkets(FEED_DOGE).length, 1);
    }

    function test_CreatedMarket_HasCorrectParams() public {
        vm.prank(resolver);
        address m = factory.createMarket(FEED_PEPE, 15 minutes);
        OrderbookMarket ob = OrderbookMarket(m);

        assertEq(address(ob.usdc()),           address(usdc));
        assertEq(address(ob.resolver()),       resolver);
        assertEq(address(ob.liquidityPool()),  address(pool));
        assertEq(ob.feeDistributor(),          factory.feeDistributor());
        assertEq(ob.referralRegistry(),        factory.referralRegistry());
        assertEq(ob.multisig(),                multisig);
        assertEq(ob.pythFeedId(),              FEED_PEPE);
        assertEq(ob.duration(),                15 minutes);
    }
}
