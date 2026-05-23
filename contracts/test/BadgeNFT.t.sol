// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BadgeNFT.sol";

contract BadgeNFTTest is Test {
    BadgeNFT badges;

    address admin   = address(this);
    address minter  = makeAddr("minter");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");

    function setUp() public {
        badges = new BadgeNFT("ipfs://CID/");
        badges.addMinter(minter);
    }

    // ── ROLES ─────────────────────────────────────────────
    function test_Deployer_Is_Admin() public view {
        assertTrue(badges.hasRole(badges.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_AddMinter_OnlyAdmin() public {
        address newMinter = makeAddr("m2");
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        badges.addMinter(newMinter);

        badges.addMinter(newMinter);
        assertTrue(badges.hasRole(badges.MINTER_ROLE(), newMinter));
    }

    function test_RemoveMinter_OnlyAdmin() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        badges.removeMinter(minter);

        badges.removeMinter(minter);
        assertFalse(badges.hasRole(badges.MINTER_ROLE(), minter));
    }

    // ── MINT ──────────────────────────────────────────────
    function test_MintBadge_Success() public {
        vm.prank(minter); badges.mintBadge(alice, 1);
        assertEq(badges.balanceOf(alice, 1), 1);
    }

    function test_MintBadge_EmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit BadgeNFT.BadgeEarned(alice, 1, "Beginner");
        vm.prank(minter); badges.mintBadge(alice, 1);
    }

    function test_MintBadge_Reverts_NonMinter() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        badges.mintBadge(alice, 1);
    }

    function test_MintBadge_Reverts_UnknownId() public {
        vm.prank(minter);
        vm.expectRevert("badge not found");
        badges.mintBadge(alice, 999);
    }

    function test_MintBadge_Reverts_AlreadyHas() public {
        vm.prank(minter); badges.mintBadge(alice, 1);
        vm.prank(minter);
        vm.expectRevert("already has badge");
        badges.mintBadge(alice, 1);
    }

    function test_MintBadge_AllRegisteredIds() public {
        for (uint256 i = 1; i <= 16; i++) {
            vm.prank(minter); badges.mintBadge(alice, i);
            assertEq(badges.balanceOf(alice, i), 1);
        }
    }

    // ── SOULBOUND ─────────────────────────────────────────
    function test_Transfer_Reverts_Soulbound() public {
        vm.prank(minter); badges.mintBadge(alice, 1);
        vm.prank(alice);
        vm.expectRevert("Soulbound: non-transferable");
        badges.safeTransferFrom(alice, bob, 1, 1, "");
    }

    function test_BatchTransfer_Reverts_Soulbound() public {
        vm.prank(minter); badges.mintBadge(alice, 1);
        vm.prank(minter); badges.mintBadge(alice, 2);
        uint256[] memory ids = new uint256[](2); ids[0] = 1; ids[1] = 2;
        uint256[] memory amts = new uint256[](2); amts[0] = 1; amts[1] = 1;
        vm.prank(alice);
        vm.expectRevert("Soulbound: non-transferable");
        badges.safeBatchTransferFrom(alice, bob, ids, amts, "");
    }

    // ── BADGE REGISTRY ────────────────────────────────────
    function test_Badge_Metadata_AllRegistered() public view {
        for (uint256 i = 1; i <= 16; i++) {
            (, , bool exists) = badges.badges(i);
            assertTrue(exists, "badge registered");
        }
    }

    function test_Badge_Rarities() public view {
        (, string memory r1,)  = badges.badges(1);   // Beginner — common
        (, string memory r3,)  = badges.badges(3);   // Diamond — rare
        (, string memory r7,)  = badges.badges(7);   // To The Moon — epic
        (, string memory r9,)  = badges.badges(9);   // Legend — legendary
        assertEq(r1, "common");
        assertEq(r3, "rare");
        assertEq(r7, "epic");
        assertEq(r9, "legendary");
    }

    // ── URI ───────────────────────────────────────────────
    function test_URI_Suffix() public view {
        // base "ipfs://CID/" + "1" + ".json"
        assertEq(badges.uri(1), "ipfs://CID/1.json");
        assertEq(badges.uri(16), "ipfs://CID/16.json");
    }

    // ── INTERFACE ─────────────────────────────────────────
    function test_SupportsInterface() public view {
        // ERC1155: 0xd9b67a26
        assertTrue(badges.supportsInterface(0xd9b67a26));
        // AccessControl: 0x7965db0b
        assertTrue(badges.supportsInterface(0x7965db0b));
        // ERC165: 0x01ffc9a7
        assertTrue(badges.supportsInterface(0x01ffc9a7));
        // random
        assertFalse(badges.supportsInterface(0x12345678));
    }
}
