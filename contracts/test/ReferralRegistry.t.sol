// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReferralRegistry.sol";
import "./mocks/MockMarketRegistry.sol";

contract ReferralRegistryTest is Test {
    ReferralRegistry registry;
    MockMarketRegistry factory;

    address owner = makeAddr("owner");
    address market = makeAddr("market");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address charlie = makeAddr("charlie");

    function setUp() public {
        vm.prank(owner);
        registry = new ReferralRegistry();

        // A real registry rather than nothing: authorizeMarket now asks the
        // factory whether it created the address it is handed.
        factory = new MockMarketRegistry();
        factory.register(market);
        vm.prank(owner);
        registry.setMarketFactory(address(factory));

        vm.prank(owner);
        registry.authorizeMarket(market);
    }

    /**
     * Matches LiquidityPool and FeeDistributor. An authorized address can call
     * register(victim, attacker) and pin a referral link on anyone, skimming
     * their referral share from then on. Owner-gated, so this bounds a key
     * compromise rather than closing an open door.
     */
    function test_AuthorizeMarket_RejectsAnAddressTheFactoryNeverCreated() public {
        vm.prank(owner);
        vm.expectRevert("not a market");
        registry.authorizeMarket(makeAddr("attacker"));
    }

    function test_Register() public {
        vm.prank(market);
        registry.register(bob, alice); // alice referred bob

        assertEq(registry.getReferrer(bob), alice);
        assertEq(registry.getReferralCount(alice), 1);
    }

    function test_Register_OnlyOnce() public {
        vm.prank(market);
        registry.register(bob, alice);
        vm.prank(market);
        registry.register(bob, charlie); // should be ignored

        assertEq(registry.getReferrer(bob), alice); // still alice
    }

    function test_Register_NoSelfReferral() public {
        vm.prank(market);
        vm.expectRevert("self referral");
        registry.register(alice, alice);
    }

    function test_Register_OnlyAuthorized() public {
        vm.prank(alice); // not authorized
        vm.expectRevert("unauthorized");
        registry.register(bob, alice);
    }

    function test_GenerateCode() public {
        vm.prank(alice);
        registry.generateCode(alice);
        bytes6 code = registry.referrerToCode(alice);
        assertTrue(code != bytes6(0));
        assertEq(registry.resolveCode(code), alice);
    }

    function test_GenerateCode_OnlyOnce() public {
        vm.prank(alice);
        registry.generateCode(alice);
        vm.prank(alice);
        vm.expectRevert("code exists");
        registry.generateCode(alice);
    }

    // Audit fix (S4, 2026-07-05): generateCode(referrer) was callable by
    // anyone for any address — no way to steal funds, but it let a
    // griefer spend an arbitrary address's "first code" slot without consent.
    function test_GenerateCode_Reverts_NotSelf() public {
        vm.prank(bob); // bob tries to generate a code on alice's behalf
        vm.expectRevert("only self");
        registry.generateCode(alice);
    }

    function test_RevokeMarket() public {
        vm.prank(owner);
        registry.revokeMarket(market);

        vm.prank(market);
        vm.expectRevert("unauthorized");
        registry.register(bob, alice);
    }
}
