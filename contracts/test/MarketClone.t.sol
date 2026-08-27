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

/**
 * Sprint 5.6 — markets are EIP-1167 clones rather than full deployments.
 *
 * The rest of the suite exercises markets built by `new OrderbookMarketHarness(...)`,
 * which runs a constructor. A clone never does: it starts with completely
 * empty storage and borrows the implementation's *code*. Every assertion here
 * is about that gap — the class of bug where something is set up in the
 * constructor, keeps passing every existing test (they all deploy directly),
 * and is silently zero on every market real users actually touch.
 */
contract MarketCloneTest is RedstoneTest {
    MockUSDC      usdc;
    address       resolver;
    GenesisNFT    genesisNFT;
    LiquidityPool pool;
    MarketFactoryHarness factory;

    address treasury = makeAddr("treasury");
    address multisig = makeAddr("multisig");
    address alice    = makeAddr("alice");
    address bob      = makeAddr("bob");

    bytes32 constant FEED_PEPE = bytes32("PEPE/USD");
    bytes32 constant FEED_DOGE = bytes32("DOGE/USD");

    uint256 constant ENTRY_PRICE = 9142e12; // 914200 with expo -8
    uint256 constant DUR_15M     = 15 minutes;
    uint256 constant DUR_1H      = 1 hours;

    function setUp() public {
        usdc     = new MockUSDC();
        resolver = makeAddr("resolver");
        // Priced per clone in _clone(): rsFeedId is a single register, so
        // setting both here would leave only the last one and hand every PEPE
        // market a DOGE payload.

        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        FeeDistributor   feeDist = new FeeDistributor(address(usdc), treasury, treasury, treasury);
        ReferralRegistry refReg  = new ReferralRegistry();

        factory = new MarketFactoryHarness(
            address(usdc), resolver, address(feeDist),
            address(refReg), multisig, address(pool)
        );

        pool.setMarketFactory(address(factory));
        feeDist.setMarketFactory(address(factory));
        refReg.setMarketFactory(address(factory));
        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);

        usdc.mint(alice, 1000e6);
        usdc.mint(bob,   1000e6);
    }

    function _clone(bytes32 feed, uint256 dur) internal returns (OrderbookMarket) {
        // Payloads have to be signed for the feed this clone prices.
        _setPrice(feed, 914200);
        return OrderbookMarket(factory.createMarket(feed, dur));
    }

    function _approve(address who, address market) internal {
        vm.prank(who);
        usdc.approve(market, type(uint256).max);
    }

    // ── THE REGRESSION THAT MOTIVATED THIS FILE ───────────
    /// Order/match ids were `uint256 public nextOrderId = 1` — an inline
    /// field initializer, i.e. constructor code. A clone would have started
    /// both at 0, and 0 is the "no match" sentinel in Order.matchId, so a
    /// genuinely matched order would have looked unmatched forever.
    function test_Clone_IdCountersStartAtOne() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        assertEq(m.nextOrderId(), 1, "nextOrderId must not be 0 on a clone");
        assertEq(m.nextMatchId(), 1, "nextMatchId must not be 0 on a clone");
    }

    /// The sentinel itself: an unmatched order reports matchId 0, and a
    /// matched one reports non-zero. Only holds if the counter skipped 0.
    function test_Clone_MatchIdZeroStaysMeaningful() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        _approve(alice, address(m));
        _approve(bob,   address(m));

        uint256 aliceId = _bet(m, alice, OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);
        assertEq(m.getOrder(aliceId).matchId, 0, "unmatched order must read as matchId 0");

        uint256 bobId = _bet(m, bob, OrderbookMarket.Direction.DOWN, 50e6, address(0), ENTRY_PRICE, 100);
        assertTrue(m.getOrder(bobId).matchId != 0, "matched order must not collide with the 0 sentinel");
        assertEq(m.getOrder(aliceId).matchId, m.getOrder(bobId).matchId);
    }

    // ── IMMUTABLES REACH THE CLONE ────────────────────────
    function test_Clone_ReadsImplementationImmutables() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        assertEq(address(m.usdc()),     address(usdc));
        assertEq(m.resolver(),          resolver);
        assertEq(m.liquidityPool(),     address(pool));
        assertEq(m.multisig(),          multisig);
        // The one that gates initialize() and pauseByFactory() on every clone.
        assertEq(m.factory(),           address(factory));
    }

    // ── PER-INSTANCE CONFIG IS NOT SHARED ─────────────────
    function test_Clone_PerInstanceConfigIsIsolated() public {
        OrderbookMarket a = _clone(FEED_PEPE, DUR_15M);
        OrderbookMarket b = _clone(FEED_DOGE, DUR_1H);

        assertTrue(address(a) != address(b));
        assertEq(a.feedId(), FEED_PEPE);
        assertEq(b.feedId(), FEED_DOGE);
        assertEq(a.duration(),   DUR_15M);
        assertEq(b.duration(),   DUR_1H);
    }

    /// Clones delegatecall shared code but must never share *storage*.
    function test_Clone_StorageIsIsolatedBetweenMarkets() public {
        OrderbookMarket a = _clone(FEED_PEPE, DUR_15M);
        OrderbookMarket b = _clone(FEED_DOGE, DUR_1H);

        _approve(alice, address(a));
        // Cloning B moved the payload register to DOGE; bet on A and the
        // payload must be for A's feed again.
        _setPrice(FEED_PEPE, 914200);
        _bet(a, alice, OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);

        assertEq(a.nextOrderId(), 2, "market A should have consumed an id");
        assertEq(b.nextOrderId(), 1, "market B must be untouched by A's activity");
        assertEq(usdc.balanceOf(address(b)), 0, "funds must not be visible to a sibling clone");
    }

    // ── INITIALIZATION GUARDS ─────────────────────────────
    function test_Clone_CannotBeReinitialized() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        vm.prank(address(factory));
        vm.expectRevert("already initialized");
        m.initialize(FEED_DOGE, DUR_1H, multisig, 0);
    }

    function test_Clone_InitializeRejectsNonFactory() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert("only factory");
        m.initialize(FEED_DOGE, DUR_1H, multisig, 0);
    }

    /// The implementation is left permanently initialized by its own
    /// constructor, so it can't be claimed by a passer-by.
    function test_Implementation_CannotBeInitialized() public {
        OrderbookMarket impl = OrderbookMarket(factory.marketImplementation());
        vm.prank(address(factory));
        vm.expectRevert("already initialized");
        impl.initialize(FEED_PEPE, DUR_15M, multisig, 0);
    }

    function test_Implementation_IsDistinctFromEveryClone() public {
        address impl = factory.marketImplementation();
        assertTrue(impl != address(0));
        assertTrue(impl != address(_clone(FEED_PEPE, DUR_15M)));
    }

    /// A directly-deployed market (the path the rest of the suite uses) is
    /// still configured and locked in one step.
    function test_DirectDeploy_StillWorksAndIsLocked() public {
        OrderbookMarket m = new OrderbookMarketHarness(
            address(usdc), resolver, address(pool), treasury,
            address(0), multisig, FEED_PEPE, DUR_15M
        );
        assertEq(m.feedId(),  FEED_PEPE);
        assertEq(m.duration(),    DUR_15M);
        assertEq(m.nextOrderId(), 1);
        assertEq(m.factory(),     address(this)); // deployer

        vm.expectRevert("already initialized");
        m.initialize(FEED_DOGE, DUR_1H, multisig, 0);
    }

    // ── FACTORY-GATED CONTROLS STILL REACH CLONES ─────────
    function test_Clone_PauseByFactoryWorks() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        _approve(alice, address(m));

        factory.pauseMarketsForFeed(FEED_PEPE);

        (bool rsOk,) = _tryBet(m, alice, OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);
        assertFalse(rsOk, "expected the bet to be rejected");
    }

    // ── END-TO-END THROUGH A CLONE ────────────────────────
    function test_Clone_FullLifecycle_PvP() public {
        OrderbookMarket m = _clone(FEED_PEPE, DUR_15M);
        _approve(alice, address(m));
        _approve(bob,   address(m));

        uint256 aliceId = _bet(m, alice, OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);
        _bet(m, bob, OrderbookMarket.Direction.DOWN, 50e6, address(0), ENTRY_PRICE, 100);

        uint256 matchId = m.getOrder(aliceId).matchId;
        assertEq(matchId, 1, "first match on a clone must be id 1");

        vm.warp(block.timestamp + DUR_15M + 1);

        // UP wins: exit above entry.
        vm.prank(resolver);
        m.settleMatch(matchId, ENTRY_PRICE + 100);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        m.claim(aliceId);
        assertEq(usdc.balanceOf(alice) - before, 100e6, "winner takes both stakes at 0% fee");
    }

    // ── THE POINT OF THE EXERCISE ─────────────────────────
    /// Guards the cost regression this refactor exists to fix. A full
    /// `new OrderbookMarketHarness(...)` was ~3.85M gas; the clone path should sit
    /// near ~250k. The bound is deliberately loose — it's here to catch
    /// someone reverting to a real deployment, not to police ±10k.
    function test_Gas_CreateMarketStaysCheap() public {
        uint256 before = gasleft();
        factory.createMarket(FEED_PEPE, DUR_15M);
        uint256 used = before - gasleft();

        emit log_named_uint("createMarket gas", used);
        assertLt(used, 600_000, "createMarket regressed toward a full deployment");
    }
}
