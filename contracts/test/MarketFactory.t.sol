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
import "./helpers/RedstoneTest.sol";
import "./helpers/RedstoneHarness.sol";

contract MarketFactoryTest is RedstoneTest {
    MockUSDC      usdc;
    address       resolver;
    GenesisNFT    genesisNFT;
    LiquidityPool pool;
    MarketFactoryHarness factory;

    address treasury = makeAddr("treasury");
    address multisig = makeAddr("multisig");
    address keeper   = makeAddr("keeper");

    bytes32 constant FEED_PEPE = bytes32("PEPE/USD");
    bytes32 constant FEED_DOGE = bytes32("DOGE/USD");

    function setUp() public {
        usdc       = new MockUSDC();
        resolver   = makeAddr("resolver");
        _setPrice(FEED_PEPE, 1000e8);
        _setPrice(FEED_DOGE, 2000e8);

        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        // Deploy real FeeDistributor + ReferralRegistry so factory can authorize them.
        FeeDistributor   feeDist   = new FeeDistributor(address(usdc), treasury, treasury, treasury);
        ReferralRegistry refReg    = new ReferralRegistry();

        factory = new MarketFactoryHarness(
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

    // Audit fix (S5, 2026-07-05): getAllFeedIds() is what the off-chain
    // keeper (marketCreator.ts) polls to decide which feeds to spawn markets
    // for. Before this fix it kept returning removed feeds forever, forcing
    // every caller to separately re-check allowedFeeds() to avoid acting on
    // stale entries.
    function test_GetAllFeedIds_ExcludesRemovedFeed() public {
        factory.removeFeed(FEED_PEPE);
        bytes32[] memory ids = factory.getAllFeedIds();
        assertEq(ids.length, 1);
        assertEq(ids[0], FEED_DOGE);
    }

    function test_AddFeed_ReAdd_DoesNotDuplicateInList() public {
        factory.removeFeed(FEED_PEPE);
        factory.addFeed(FEED_PEPE); // re-add the same feed
        bytes32[] memory ids = factory.getAllFeedIds();
        assertEq(ids.length, 2, "re-adding an existing feed must not duplicate it");
        assertTrue(factory.allowedFeeds(FEED_PEPE));
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

    // ── marketCreator role (Sprint 5 finding) ─────────────
    function test_SetMarketCreator_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(); // Ownable: caller is not the owner
        factory.setMarketCreator(keeper);

        // owner succeeds
        factory.setMarketCreator(keeper);
        assertEq(factory.marketCreator(), keeper);
    }

    function test_CreateMarket_ByMarketCreator() public {
        factory.setMarketCreator(keeper);

        // keeper is neither owner nor resolver, but holds the creator role
        vm.prank(keeper);
        address m = factory.createMarket(FEED_PEPE, 5 minutes);
        assertTrue(pool.isAuthorizedMarket(m), "creator-spawned market authorized");
        assertEq(factory.getActiveMarkets(FEED_PEPE).length, 1);
    }

    function test_CreateMarket_Reverts_AfterCreatorRevoked() public {
        factory.setMarketCreator(keeper);
        factory.setMarketCreator(address(0)); // revoke

        vm.prank(keeper);
        vm.expectRevert("unauthorized");
        factory.createMarket(FEED_PEPE, 5 minutes);
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
        assertEq(ob.feedId(),              FEED_PEPE);
        assertEq(ob.duration(),                15 minutes);
    }

    // ── duplicate-market guard (Sprint 5.5 audit fix) ─────
    /// @notice Defense in depth: the off-chain keeper (marketCreator.ts)
    ///         already dedupes via a DB lookup, but that DB can be stale or
    ///         desynced. This guards on-chain against a buggy/retried caller
    ///         spawning two live markets for the same (feedId, duration)
    ///         back-to-back.
    function test_CreateMarket_Reverts_DuplicateWithinCooldown() public {
        vm.startPrank(resolver);
        factory.createMarket(FEED_PEPE, 15 minutes);
        vm.expectRevert("duplicate market slot");
        factory.createMarket(FEED_PEPE, 15 minutes);
        vm.stopPrank();
    }

    function test_CreateMarket_DifferentDuration_NotBlockedByCooldown() public {
        vm.startPrank(resolver);
        factory.createMarket(FEED_PEPE, 15 minutes);
        address m2 = factory.createMarket(FEED_PEPE, 5 minutes); // different duration, same feed
        vm.stopPrank();
        assertTrue(pool.isAuthorizedMarket(m2));
    }

    function test_CreateMarket_DifferentFeed_NotBlockedByCooldown() public {
        vm.startPrank(resolver);
        factory.createMarket(FEED_PEPE, 15 minutes);
        address m2 = factory.createMarket(FEED_DOGE, 15 minutes); // different feed, same duration
        vm.stopPrank();
        assertTrue(pool.isAuthorizedMarket(m2));
    }

    function test_CreateMarket_AllowedAfterCooldown() public {
        vm.startPrank(resolver);
        factory.createMarket(FEED_PEPE, 15 minutes);
        vm.warp(block.timestamp + factory.MIN_CREATE_INTERVAL() + 1);
        address m2 = factory.createMarket(FEED_PEPE, 15 minutes);
        vm.stopPrank();
        assertTrue(pool.isAuthorizedMarket(m2));
    }

    /// @notice The guard must not fight the intended off-chain rollover
    ///         strategy: marketCreator.ts recreates a market once the
    ///         current one is ~50% of its way to close (CREATE_LEAD_RATIO),
    ///         which for the shortest allowed duration (5 min) is 150s —
    ///         comfortably above any sane anti-duplicate cooldown.
    function test_CreateMarket_EarlyRolloverAt50Percent_StillWorks() public {
        vm.startPrank(resolver);
        factory.createMarket(FEED_PEPE, 5 minutes); // shortest allowed duration
        vm.warp(block.timestamp + 5 minutes / 2);
        address m2 = factory.createMarket(FEED_PEPE, 5 minutes);
        vm.stopPrank();
        assertTrue(pool.isAuthorizedMarket(m2));
    }

    // ── emergency pause (Sprint 5.5 coverage hardening) ───
    function test_SetEmergencyPauser_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        factory.setEmergencyPauser(keeper);

        factory.setEmergencyPauser(keeper);
        assertEq(factory.emergencyPauser(), keeper);
    }

    function test_PauseMarketsForFeed_ByOwner() public {
        vm.prank(resolver);
        address m = factory.createMarket(FEED_PEPE, 15 minutes);

        factory.pauseMarketsForFeed(FEED_PEPE);
        assertTrue(OrderbookMarket(m).paused());
    }

    function test_PauseMarketsForFeed_ByEmergencyPauser() public {
        factory.setEmergencyPauser(keeper);
        vm.prank(resolver);
        address m = factory.createMarket(FEED_PEPE, 15 minutes);

        vm.prank(keeper);
        factory.pauseMarketsForFeed(FEED_PEPE);
        assertTrue(OrderbookMarket(m).paused());
    }

    function test_PauseMarketsForFeed_Reverts_Unauthorized() public {
        vm.prank(resolver);
        factory.createMarket(FEED_PEPE, 15 minutes);

        vm.prank(makeAddr("rogue"));
        vm.expectRevert("not authorized");
        factory.pauseMarketsForFeed(FEED_PEPE);
    }

    function test_PauseMarketsForFeed_PausesAllMarketsForThatFeed() public {
        vm.startPrank(resolver);
        address m1 = factory.createMarket(FEED_PEPE, 5 minutes);
        address m2 = factory.createMarket(FEED_PEPE, 15 minutes);
        vm.stopPrank();

        factory.pauseMarketsForFeed(FEED_PEPE);

        assertTrue(OrderbookMarket(m1).paused());
        assertTrue(OrderbookMarket(m2).paused());
    }

    /**
     * Give a feed `count` distinct, long-expired markets.
     *
     * Distinct matters: pushing one address repeatedly would leave every call
     * after the first warm, and the gas figure these tests rest on would mean
     * nothing. vm.etch rather than 1500 deployments keeps it quick.
     */
    function _seedExpiredMarkets(bytes32 feedId, uint256 count) internal {
        bytes memory stub = address(new ExpiredMarketStub()).code;
        for (uint256 i = 0; i < count; i++) {
            address m = address(uint160(0x5000 + i));
            vm.etch(m, stub);
            factory.pushActiveMarket(feedId, m);
        }
    }

    /**
     * The emergency stop has to keep fitting in one transaction.
     *
     * activeMarkets[feedId] is append-only - every market ever created for the
     * feed stays in it - and the sweep walked the whole thing. The keeper rolls
     * a fresh market per duration every duration/2, so on the 5-minute slot
     * alone that array grows by hundreds a day. Within a couple of weeks the
     * loop no longer fits in a block, and because the flag is written in the
     * same transaction, running out of gas would take `feedPaused` down with
     * it: the one-call emergency stop would stop existing, silently, some time
     * after launch.
     */
    function test_PauseMarketsForFeed_CostDoesNotGrowWithFeedHistory() public {
        // History first, then the markets that are currently trading - the
        // order createMarket actually produces, and the one the bounded sweep
        // relies on.
        //
        // Both feeds hold more markets than one sweep covers; one holds seven
        // times as many as the other. Past the bound, history length is the
        // thing that must stop mattering.
        _seedExpiredMarkets(FEED_PEPE, 200);
        _seedExpiredMarkets(FEED_DOGE, 1500);

        vm.startPrank(resolver);
        address livePepe = factory.createMarket(FEED_PEPE, 15 minutes);
        address liveDoge = factory.createMarket(FEED_DOGE, 15 minutes);
        vm.stopPrank();

        uint256 shorter = _gasToPause(FEED_PEPE);
        uint256 longer  = _gasToPause(FEED_DOGE);

        // Asserted as a ratio rather than a gas ceiling on purpose: the
        // absolute numbers here are not the chain's, since vm.etch leaves the
        // seeded accounts warm. What has to hold is that the sweep stops
        // scaling with how long the feed has existed.
        assertApproxEqRel(longer, shorter, 0.10e18, "an old feed must not cost more to stop than a newer one");
        assertTrue(factory.feedPaused(FEED_PEPE), "the flag is the part that must always hold");
        assertTrue(factory.feedPaused(FEED_DOGE));
        assertTrue(OrderbookMarket(livePepe).paused(), "the markets that are actually live still get paused");
        assertTrue(OrderbookMarket(liveDoge).paused());
    }

    function _gasToPause(bytes32 feedId) internal returns (uint256) {
        uint256 before = gasleft();
        factory.pauseMarketsForFeed(feedId);
        return before - gasleft();
    }

    /**
     * The bound is only safe because the live markets are the newest ones.
     * Creation is chronological, so sweeping from the end reaches everything
     * that can still be trading; the entries further back closed long ago and
     * pausing them would change nothing.
     */
    function test_PauseMarketsForFeed_PausesTheNewestMarkets_NotTheOldest() public {
        _seedExpiredMarkets(FEED_PEPE, 1500);
        vm.startPrank(resolver);
        address m1 = factory.createMarket(FEED_PEPE, 5 minutes);
        address m2 = factory.createMarket(FEED_PEPE, 15 minutes);
        vm.stopPrank();

        factory.pauseMarketsForFeed(FEED_PEPE);

        assertTrue(OrderbookMarket(m1).paused(), "newest markets are the ones that matter");
        assertTrue(OrderbookMarket(m2).paused());
    }
}
