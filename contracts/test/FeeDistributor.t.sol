// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/FeeDistributor.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockMarketRegistry.sol";

contract FeeDistributorTest is Test {
    FeeDistributor dist;
    MockUSDC usdc;
    MockMarketRegistry registry;

    address treasury = makeAddr("treasury");
    address lpSink = makeAddr("lpSink");
    address nftPool = makeAddr("nftPool");
    address factory;
    address market = makeAddr("market");
    address ref = makeAddr("ref");

    function setUp() public {
        usdc = new MockUSDC();
        dist = new FeeDistributor(address(usdc), treasury, lpSink, nftPool);

        // A real registry rather than a bare address: authorizeMarket now asks
        // the factory whether it created the address it is handed.
        registry = new MockMarketRegistry();
        registry.register(market);
        factory = address(registry);

        dist.setMarketFactory(factory);
        vm.prank(factory);
        dist.authorizeMarket(market);
    }

    function _push(uint256 fee) internal {
        usdc.mint(address(this), fee);
        usdc.transfer(address(dist), fee);
    }

    // ─── auth ────────────────────────────────────────────
    function test_SetMarketFactory_OnceOnly() public {
        FeeDistributor d2 = new FeeDistributor(address(usdc), treasury, lpSink, nftPool);
        d2.setMarketFactory(factory);
        vm.expectRevert("factory already set");
        d2.setMarketFactory(makeAddr("other"));
    }

    function test_AuthorizeMarket_OnlyFactoryOrOwner() public {
        address m2 = makeAddr("m2");
        registry.register(m2);

        vm.prank(makeAddr("rogue"));
        vm.expectRevert("only factory or owner");
        dist.authorizeMarket(m2);

        // owner allowed
        dist.authorizeMarket(m2);
        assertTrue(dist.isAuthorizedMarket(m2));
    }

    /**
     * The same hardening LiquidityPool.authorizeMarket got, for the same
     * reason. distributeFee pays out of the balance already sitting here
     * without checking that any USDC arrived with the call, so an authorized
     * address can credit itself referral fees and push the rest to the sinks.
     * Only the owner can authorize, so this bounds an owner-key compromise
     * rather than closing an open door - but leaving one of three sibling
     * contracts unguarded is how a compromise finds the cheapest way in.
     */
    function test_AuthorizeMarket_RejectsAnAddressTheFactoryNeverCreated() public {
        vm.expectRevert("not a market");
        dist.authorizeMarket(makeAddr("attacker"));
    }

    function test_Deauthorize_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        dist.deauthorizeMarket(market);

        dist.deauthorizeMarket(market);
        assertFalse(dist.isAuthorizedMarket(market));
    }

    function test_DistributeFee_Reverts_Unauthorized() public {
        _push(100e6);
        vm.prank(makeAddr("rogue"));
        vm.expectRevert("not authorized market");
        dist.distributeFee(100e6, ref);
    }

    function test_DistributeFee_Reverts_ZeroFee() public {
        vm.prank(market);
        vm.expectRevert("zero fee");
        dist.distributeFee(0, ref);
    }

    // ─── distribution math ───────────────────────────────
    function test_DistributeFee_WithReferrer() public {
        _push(100e6);
        vm.prank(market);
        dist.distributeFee(100e6, ref);

        // 40% to referrer, remaining 60 split 20/20/20 of 60 ≈ 20 each
        assertEq(dist.referralBalance(ref), 40e6, "ref 40");
        assertEq(usdc.balanceOf(treasury), 20e6, "treasury 20");
        assertEq(usdc.balanceOf(lpSink), 20e6, "lpSink 20");
        assertEq(usdc.balanceOf(nftPool), 20e6, "nftPool 20");
    }

    function test_DistributeFee_NoReferrer_FullSplit() public {
        _push(60e6);
        vm.prank(market);
        dist.distributeFee(60e6, address(0));

        // No referrer → entire 60 split across 3 sinks ≈ 20 each
        assertEq(dist.referralBalance(address(0)), 0);
        assertEq(usdc.balanceOf(treasury), 20e6);
        assertEq(usdc.balanceOf(lpSink), 20e6);
        assertEq(usdc.balanceOf(nftPool), 20e6);
    }

    function test_DistributeFee_OddAmount_NoLeak() public {
        _push(101);
        vm.prank(market);
        dist.distributeFee(101, address(0));
        // NFT gets the rounding remainder
        uint256 total = usdc.balanceOf(treasury) + usdc.balanceOf(lpSink) + usdc.balanceOf(nftPool);
        assertEq(total, 101, "no leak");
    }

    // ─── claim ──────────────────────────────────────────
    function test_ClaimReferralRewards() public {
        _push(100e6);
        vm.prank(market);
        dist.distributeFee(100e6, ref);

        uint256 balBefore = usdc.balanceOf(ref);
        vm.prank(ref);
        dist.claimReferralRewards();
        assertEq(usdc.balanceOf(ref) - balBefore, 40e6);
        assertEq(dist.referralBalance(ref), 0);
    }

    function test_ClaimReferralRewards_Reverts_Nothing() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert("nothing to claim");
        dist.claimReferralRewards();
    }

    // ─── admin setters ──────────────────────────────────
    function test_SetTreasury_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        dist.setTreasury(makeAddr("x"));

        dist.setTreasury(makeAddr("x"));
        assertEq(dist.treasury(), makeAddr("x"));
    }

    function test_SetLiquidityPool_OnlyOwner() public {
        dist.setLiquidityPool(makeAddr("lp2"));
        assertEq(dist.liquidityPool(), makeAddr("lp2"));
    }

    function test_SetNftRewardsPool_OnlyOwner() public {
        dist.setNftRewardsPool(makeAddr("nft2"));
        assertEq(dist.nftRewardsPool(), makeAddr("nft2"));
    }

    function test_Constructor_Reverts_ZeroAddress() public {
        vm.expectRevert("zero address");
        new FeeDistributor(address(0), treasury, lpSink, nftPool);
    }

    // ─── sweepDust (Sprint 5.5 coverage hardening) ────────
    function test_SweepDust_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        dist.sweepDust();
    }

    function test_SweepDust_ReturnsZero_WhenNoDust() public {
        assertEq(dist.sweepDust(), 0);
    }

    function test_SweepDust_ExcludesReferralOwed() public {
        _push(100e6);
        vm.prank(market);
        dist.distributeFee(100e6, ref); // 40e6 (REF_BPS) sits owed, pull pattern

        assertEq(dist.totalReferralOwed(), 40e6);
        assertEq(usdc.balanceOf(address(dist)), 40e6);

        assertEq(dist.sweepDust(), 0, "no dust - remaining balance is all owed to the referrer");
    }

    function test_SweepDust_SweepsOnlyExcessBeyondReferralOwed() public {
        _push(100e6);
        vm.prank(market);
        dist.distributeFee(100e6, ref); // 40e6 owed sits in the contract

        // Extra USDC lands directly (rounding dust / accidental transfer).
        usdc.mint(address(dist), 5e6);

        uint256 before = usdc.balanceOf(treasury);
        uint256 dust = dist.sweepDust();
        assertEq(dust, 5e6, "only the extra 5e6 is dust, not the 40e6 owed to the referrer");
        assertEq(usdc.balanceOf(treasury) - before, 5e6);
        assertEq(usdc.balanceOf(address(dist)), 40e6, "referrer's owed balance untouched");
    }
}
