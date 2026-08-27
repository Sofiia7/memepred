// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The four structural findings from the 2026-08-09 pre-launch audit.
 *
 * Each of these is the reason the protocol could not go to mainnet as written,
 * and each needed a contract change rather than an operational one. Kept in one
 * file because they are one story: config that has to be able to change lives
 * on the factory, not frozen into ephemeral market clones.
 */

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

contract LaunchBlockersTest is RedstoneTest {
    MockUSDC      usdc;
    address       resolver;
    GenesisNFT    genesisNFT;
    LiquidityPool pool;
    MarketFactoryHarness factory;

    address treasury  = makeAddr("treasury");
    address multisig  = makeAddr("multisig-standin");
    address safe      = makeAddr("gnosis-safe");
    address keeper    = makeAddr("keeper");
    address attacker  = makeAddr("attacker");

    bytes32 constant FEED_PEPE = bytes32("PEPE/USD");
    bytes32 constant FEED_DOGE = bytes32("DOGE/USD");
    uint256 constant DUR       = 1 hours;

    function setUp() public {
        usdc       = new MockUSDC();
        resolver   = makeAddr("resolver");
        _setPrice(FEED_PEPE, 1000e8);
        _setPrice(FEED_DOGE, 2000e8);

        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        FeeDistributor   feeDist = new FeeDistributor(address(usdc), treasury, treasury, treasury);
        ReferralRegistry refReg  = new ReferralRegistry();

        factory = new MarketFactoryHarness(
            address(usdc), resolver, address(feeDist), address(refReg), multisig, address(pool)
        );

        pool.setMarketFactory(address(factory));
        feeDist.setMarketFactory(address(factory));
        refReg.setMarketFactory(address(factory));
        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);
        factory.setMarketCreator(keeper);
        factory.setEmergencyPauser(keeper);
    }

    function _create(bytes32 feed) internal returns (OrderbookMarket) {
        vm.prank(keeper);
        return OrderbookMarket(factory.createMarket(feed, DUR));
    }

    // ── BLOCKER 1: the admin address was frozen at deploy time ──────────
    //
    // multisig was immutable on both MarketFactory and OrderbookMarket, with no
    // setter anywhere. The launch plan was to go live with an EOA stand-in and
    // move to a Safe once there was money worth protecting; that was not
    // possible, because the address is baked into the factory's code and into
    // every clone it makes. Losing or rotating the key meant redeploying the
    // whole protocol.

    function test_Multisig_CanMoveToASafe() public {
        assertEq(factory.multisig(), multisig);

        factory.setMultisig(safe);

        assertEq(factory.multisig(), safe);
    }

    function test_Multisig_OnlyOwnerCanMoveIt() public {
        vm.prank(attacker);
        vm.expectRevert();
        factory.setMultisig(attacker);
    }

    function test_Multisig_CannotBeZeroed() public {
        // Zero would leave pause, unpause and the fee permanently unreachable.
        vm.expectRevert();
        factory.setMultisig(address(0));
    }

    function test_Multisig_NewMarketsAnswerToTheNewAdmin() public {
        factory.setMultisig(safe);
        OrderbookMarket m = _create(FEED_PEPE);

        vm.prank(safe);
        m.pause();
        assertTrue(m.paused());
    }

    function test_Multisig_NewMarketsIgnoreTheOldAdmin() public {
        factory.setMultisig(safe);
        OrderbookMarket m = _create(FEED_PEPE);

        vm.prank(multisig);
        vm.expectRevert("only multisig");
        m.pause();
    }

    // ── BLOCKER 2: the protocol fee could never be switched on ──────────
    //
    // FEE_TIMELOCK was 48h and the timelock state lived on each market clone,
    // but the longest market runs 24h and is replaced at duration/2. No clone
    // ever survived its own timelock, so proposeNewFee could be called and
    // applyNewFee never could. Revenue was structurally zero apart from the 1%
    // LP taker fee. Moving the timelock to the factory - which is permanent -
    // is what makes it mean anything.

    function test_Fee_TimelockLivesLongEnoughToApply() public {
        factory.proposeNewFee(50);

        vm.warp(block.timestamp + factory.FEE_TIMELOCK());
        factory.applyNewFee();

        assertEq(factory.feeBps(), 50);
    }

    function test_Fee_CannotApplyEarly() public {
        factory.proposeNewFee(50);

        vm.warp(block.timestamp + factory.FEE_TIMELOCK() - 1);
        vm.expectRevert("timelock");
        factory.applyNewFee();
    }

    function test_Fee_ReachesMarketsCreatedAfterIt() public {
        factory.proposeNewFee(50);
        vm.warp(block.timestamp + factory.FEE_TIMELOCK());
        factory.applyNewFee();

        assertEq(_create(FEED_PEPE).feeBps(), 50);
    }

    // A user bets under the fee they were shown. Changing it out from under an
    // open market would settle their position on terms they never agreed to.
    function test_Fee_DoesNotChangeUnderAnAlreadyOpenMarket() public {
        OrderbookMarket before = _create(FEED_PEPE);

        factory.proposeNewFee(50);
        vm.warp(block.timestamp + factory.FEE_TIMELOCK());
        factory.applyNewFee();

        assertEq(before.feeBps(), 0);
    }

    function test_Fee_StillCappedAtOnePercent() public {
        // Read the cap first: a call made after vm.expectRevert is armed is
        // the call it checks, and FEE_MAX() succeeds.
        uint256 tooHigh = factory.FEE_MAX() + 1;
        vm.expectRevert("fee too high");
        factory.proposeNewFee(tooHigh);
    }

    function test_Fee_OnlyOwnerCanPropose() public {
        vm.prank(attacker);
        vm.expectRevert();
        factory.proposeNewFee(50);
    }

    // ── BLOCKER 3: the emergency stop did not stop anything ─────────────
    //
    // pauseMarketsForFeed paused the markets that existed at that moment, but
    // createMarket had no pause check and the keeper rolls a fresh market every
    // duration/2. Pausing a feed bought at most a few minutes before the cron
    // undid it. The whole point of an emergency stop on a bad oracle is that
    // nobody can take a position priced by it.

    function test_Pause_StopsTheKeeperFromRollingAFreshMarket() public {
        factory.pauseMarketsForFeed(FEED_PEPE);

        vm.prank(keeper);
        vm.expectRevert("feed paused");
        factory.createMarket(FEED_PEPE, DUR);
    }

    function test_Pause_SurvivesTheNextKeeperTick() public {
        _create(FEED_PEPE);
        factory.pauseMarketsForFeed(FEED_PEPE);

        // The cron fires again once the creation interval has elapsed. Before
        // this fix that call succeeded and produced a live, unpaused market on
        // the feed we had just declared unsafe.
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        vm.expectRevert("feed paused");
        factory.createMarket(FEED_PEPE, DUR);
    }

    function test_Pause_IsScopedToTheBadFeed() public {
        factory.pauseMarketsForFeed(FEED_PEPE);

        vm.prank(keeper);
        factory.createMarket(FEED_DOGE, DUR);
    }

    function test_Pause_TheKeeperCanTripItButNotClearIt() public {
        vm.prank(keeper);
        factory.pauseMarketsForFeed(FEED_PEPE);
        assertTrue(factory.feedPaused(FEED_PEPE));

        // Deliberately asymmetric, matching the existing pause/unpause split: a
        // low-trust hot wallet may stop trading, only the multisig may restart
        // it.
        vm.prank(keeper);
        vm.expectRevert();
        factory.unpauseFeed(FEED_PEPE);
    }

    function test_Pause_OwnerCanResumeTheFeed() public {
        factory.pauseMarketsForFeed(FEED_PEPE);
        factory.unpauseFeed(FEED_PEPE);

        vm.prank(keeper);
        factory.createMarket(FEED_PEPE, DUR);
    }

    // ── BLOCKER 4: the owner could drain the liquidity pool ─────────────
    //
    // authorizeMarket was onlyFactoryOrOwner with no check that the target was
    // a market the factory had actually created. The owner could authorize
    // their own EOA and then call the pool's match/settle entrypoints as if it
    // were a market, and onMatchSettled's LP-lost branch expects no funds back.
    // This matters because Genesis NFT exists to attract third-party deposits:
    // the people at risk are not the operator.

    function test_Pool_RefusesToAuthorizeAnEOA() public {
        vm.expectRevert("not a market");
        pool.authorizeMarket(attacker);
    }

    function test_Pool_RefusesEvenWhenTheOwnerAsks() public {
        // The owner is the whole threat model here, not the mitigation.
        assertEq(pool.owner(), address(this));

        vm.expectRevert("not a market");
        pool.authorizeMarket(address(this));
    }

    function test_Pool_StillAuthorizesRealMarkets() public {
        OrderbookMarket m = _create(FEED_PEPE);
        assertTrue(pool.isAuthorizedMarket(address(m)));
    }

    function test_Factory_KnowsWhichMarketsItMade() public {
        OrderbookMarket m = _create(FEED_PEPE);

        assertTrue(factory.isMarket(address(m)));
        assertFalse(factory.isMarket(attacker));
    }

    // A market deployed directly, bypassing the factory, is not ours: it can
    // set its own rules and then draw on pooled funds.
    function test_Pool_RefusesAMarketTheFactoryDidNotMake() public {
        OrderbookMarket rogue = new OrderbookMarketHarness(
            address(usdc), resolver, address(pool), treasury, treasury,
            attacker, FEED_PEPE, DUR
        );

        vm.expectRevert("not a market");
        pool.authorizeMarket(address(rogue));
    }
}
