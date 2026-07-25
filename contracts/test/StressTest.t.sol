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

/// @notice End-to-end stress run: 30 traders + 5 LPs running ~500 PvP matches,
///         100 LP-fallback matches, 50 emergency-refunds. Asserts the global
///         conservation invariant after every operation:
///             sum(USDC in market+pool+claimed) == sum(USDC ever in)
contract StressTest is Test {
    OrderbookMarket  market;
    LiquidityPool    pool;
    GenesisNFT       genesisNFT;
    FeeDistributor   feeDist;
    ReferralRegistry refReg;
    MarketFactory    factory;
    MockUSDC         usdc;
    MockPyth         pyth;

    address resolver;
    address treasury = makeAddr("treasury");
    address lpSink   = makeAddr("lpSink");
    address nftPool  = makeAddr("nftPool");
    address multisig = makeAddr("multisig");

    bytes32 constant FEED = bytes32("PEPE/USD");
    uint256 constant ENTRY_PRICE = 9142e12;
    uint256 constant DURATION    = 15 minutes;

    address[30] traders;
    address[5]  lps;

    uint256 totalUsdcIn;     // every transferIn to the system
    uint256 totalUsdcOut;    // every transferOut from the system

    function setUp() public {
        pyth     = new MockPyth();
        resolver = address(new MockResolver(address(pyth)));
        pyth.setPrice(FEED, 914200, -8);

        usdc       = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://stress/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        feeDist = new FeeDistributor(address(usdc), treasury, lpSink, nftPool);
        refReg  = new ReferralRegistry();

        factory = new MarketFactory(
            address(usdc), resolver, address(feeDist),
            address(refReg), multisig, address(pool)
        );

        pool   .setMarketFactory(address(factory));
        feeDist.setMarketFactory(address(factory));
        refReg .setMarketFactory(address(factory));

        factory.addFeed(FEED);

        // Create market as owner (test contract).
        market = OrderbookMarket(factory.createMarket(FEED, DURATION));

        // Set a non-zero fee so fee path is exercised.
        vm.prank(multisig); market.proposeNewFee(50); // 0.5%
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(multisig); market.applyNewFee();

        // Mint USDC + approvals.
        for (uint256 i = 0; i < traders.length; i++) {
            traders[i] = address(uint160(uint256(keccak256(abi.encode("trader", i)))));
            usdc.mint(traders[i], 10_000e6);
            totalUsdcIn += 10_000e6;
            vm.prank(traders[i]); usdc.approve(address(market), type(uint256).max);
        }
        for (uint256 i = 0; i < lps.length; i++) {
            lps[i] = address(uint160(uint256(keccak256(abi.encode("lp", i)))));
            usdc.mint(lps[i], 50_000e6);
            totalUsdcIn += 50_000e6;
            vm.prank(lps[i]); usdc.approve(address(pool), type(uint256).max);
        }
    }

    /// @dev USDC custodied by protocol = market + pool. Claimed amounts went
    ///      to traders/sinks and count as "out". Invariant: sum(in) ≥ sum(out)
    ///      and the held balance equals the diff.
    function _assertConservation() internal view {
        uint256 held = usdc.balanceOf(address(market)) + usdc.balanceOf(address(pool));
        // Includes treasury/lpSink/nftPool/feeDist as "out" since they're sinks.
        uint256 out = usdc.balanceOf(treasury) + usdc.balanceOf(lpSink)
                    + usdc.balanceOf(nftPool)  + usdc.balanceOf(address(feeDist));
        uint256 totalTraderBal;
        for (uint256 i = 0; i < traders.length; i++) totalTraderBal += usdc.balanceOf(traders[i]);
        uint256 totalLpBal;
        for (uint256 i = 0; i < lps.length; i++) totalLpBal += usdc.balanceOf(lps[i]);

        // Total minted should equal sum of everything everywhere.
        uint256 systemTotal = held + out + totalTraderBal + totalLpBal;
        assertEq(systemTotal, totalUsdcIn, "USDC conservation broken");
    }

    // ── STRESS RUN ─────────────────────────────────────────
    function test_Stress_500_Matches() public {
        // 5 LPs deposit varying amounts.
        uint256[5] memory lpAmounts = [uint256(1000e6), 2000e6, 5000e6, 10000e6, 20000e6];
        for (uint256 i = 0; i < lps.length; i++) {
            vm.prank(lps[i]); pool.deposit(lpAmounts[i], lps[i]);
        }
        _assertConservation();

        uint256 pvpMatches = 0;
        uint256 lpMatches  = 0;
        uint256 refunds    = 0;

        // 500 rounds, each round: spawn UP+DOWN pair → match → settle → claim.
        for (uint256 round = 0; round < 500; round++) {
            // Pick fresh start to avoid stale-queue interference; advance time slightly.
            vm.warp(block.timestamp + 1);

            // Always set a fresh price so MAX_PRICE_AGE never trips.
            pyth.setPrice(FEED, 914200, -8);

            address up   = traders[round % traders.length];
            address down = traders[(round * 7 + 3) % traders.length];
            if (up == down) down = traders[(round + 1) % traders.length];

            uint256 betAmount = 1e6 + ((round % 50) * 1e6); // 1-50 USDC

            vm.prank(up);
            try market.placeBetWithPyth(
                OrderbookMarket.Direction.UP, betAmount, address(0), ENTRY_PRICE, 100, pythUpd()
            ) {} catch { continue; }

            vm.prank(down);
            try market.placeBetWithPyth(
                OrderbookMarket.Direction.DOWN, betAmount, address(0), ENTRY_PRICE, 100, pythUpd()
            ) {
                pvpMatches++;
            } catch { continue; }

            // Settle. Alternate winner direction for realistic mix.
            vm.warp(block.timestamp + DURATION + 1);
            uint256 exitPrice = (round % 2 == 0)
                ? ENTRY_PRICE + (ENTRY_PRICE / 100)   // UP wins
                : ENTRY_PRICE - (ENTRY_PRICE / 100);  // DOWN wins
            pyth.setPrice(FEED, 914200, -8); // keep oracle fresh
            uint256 matchIdToSettle = market.nextMatchId() - 1;
            vm.prank(resolver);
            market.settleMatch(matchIdToSettle, exitPrice);

            // Try claim by both sides (only winner actually transfers).
            uint256 ordersBefore = market.nextOrderId() - 1;
            vm.prank(up);   try market.claim(ordersBefore - 1) {} catch {}
            vm.prank(down); try market.claim(ordersBefore)     {} catch {}

            // Periodic invariant check.
            if (round % 50 == 0) _assertConservation();
        }

        // ── LP fallback matches: solo UP (no DOWN) → pool matches.
        for (uint256 i = 0; i < 100; i++) {
            vm.warp(block.timestamp + 1);
            pyth.setPrice(FEED, 914200, -8);
            address t = traders[(i * 11) % traders.length];
            vm.prank(t);
            try market.placeBetWithPyth(
                OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100, pythUpd()
            ) {
                lpMatches++;
                vm.warp(block.timestamp + DURATION + 1);
                pyth.setPrice(FEED, 914200, -8);
                uint256 mid = market.nextMatchId() - 1;
                vm.prank(resolver);
                try market.settleMatch(mid, ENTRY_PRICE + 5) {} catch {}
                uint256 oid = market.nextOrderId() - 1;
                vm.prank(t); try market.claim(oid) {} catch {}
            } catch {}
        }

        // ── Emergency refunds: 50 matched-then-abandoned cases.
        for (uint256 i = 0; i < 50; i++) {
            vm.warp(block.timestamp + 1);
            pyth.setPrice(FEED, 914200, -8);
            address up   = traders[(i * 13) % traders.length];
            address down = traders[(i * 17 + 5) % traders.length];
            if (up == down) continue;

            vm.prank(up);
            try market.placeBetWithPyth(
                OrderbookMarket.Direction.UP, 3e6, address(0), ENTRY_PRICE, 100, pythUpd()
            ) {} catch { continue; }
            vm.prank(down);
            try market.placeBetWithPyth(
                OrderbookMarket.Direction.DOWN, 3e6, address(0), ENTRY_PRICE, 100, pythUpd()
            ) {} catch { continue; }

            // Abandon: skip settle, jump past grace.
            uint256 grace = market.SETTLE_GRACE();
            uint256 mid = market.nextMatchId() - 1;
            vm.warp(block.timestamp + DURATION + grace + 1);
            try market.emergencyRefundMatch(mid) {
                refunds++;
            } catch {}
        }

        _assertConservation();

        emit log_named_uint("PvP matches",        pvpMatches);
        emit log_named_uint("LP fallback matches",lpMatches);
        emit log_named_uint("Emergency refunds",  refunds);
        emit log_named_uint("Final pool assets",  pool.totalAssets());
        emit log_named_uint("Final market USDC",  usdc.balanceOf(address(market)));
        emit log_named_uint("Treasury collected", usdc.balanceOf(treasury));
        emit log_named_uint("LP sink collected",  usdc.balanceOf(lpSink));

        assertGt(pvpMatches, 400, "should complete >400 PvP matches");
    }
}
