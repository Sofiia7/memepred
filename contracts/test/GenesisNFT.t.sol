// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/GenesisNFT.sol";

/// @notice Standalone mock of the LiquidityPool's onGenesisTransfer hook, so
///         GenesisNFT can be tested in isolation from the real pool. Must be
///         a real contract (not a plain EOA address): Solidity's try/catch
///         does NOT catch "call to an address with no code" — that revert
///         bubbles up uncaught, unlike an actual revert from callee code.
///         In production liquidityPool is always a deployed contract, so
///         this mirrors real usage rather than working around a bug.
contract MockPoolHook {
    bool public called;
    address public lastFrom;
    address public lastTo;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function onGenesisTransfer(address from, address to) external {
        if (shouldRevert) revert("boom");
        called = true;
        lastFrom = from;
        lastTo = to;
    }
}

/// @notice Sprint 5.5 coverage hardening — GenesisNFT had no dedicated test
///         file; it was only exercised incidentally via LiquidityPool.t.sol
///         (mint through pool.deposit). This covers the admin surface
///         (mint access control + max supply, setLiquidityPool, baseURI/
///         tokenURI) and the best-effort transfer hook directly.
contract GenesisNFTTest is Test {
    GenesisNFT nft;
    MockPoolHook pool;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        nft = new GenesisNFT("ipfs://test/");
        pool = new MockPoolHook();
        nft.setLiquidityPool(address(pool));
    }

    // ── MINT ───────────────────────────────────────────────
    function test_Mint_OnlyPool() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert("only pool");
        nft.mint(alice, 1);
    }

    function test_Mint_Success() public {
        vm.prank(address(pool));
        nft.mint(alice, 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.genesisNumber(1), 1);
        assertEq(nft.totalMinted(), 1);
    }

    function test_Mint_Reverts_AfterMaxSupply() public {
        for (uint256 i = 1; i <= 20; i++) {
            vm.prank(address(pool));
            nft.mint(makeAddr(string(abi.encodePacked("lp", i))), i);
        }
        vm.prank(address(pool));
        vm.expectRevert("max supply");
        nft.mint(alice, 21);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function test_SetLiquidityPool_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        nft.setLiquidityPool(alice);
    }

    function test_SetBaseURI_OnlyOwner() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert();
        nft.setBaseURI("ipfs://new/");
    }

    // ── TOKEN URI ──────────────────────────────────────────
    function test_TokenURI_ConcatenatesBaseURIAndId() public {
        vm.prank(address(pool));
        nft.mint(alice, 1);
        assertEq(nft.tokenURI(1), "ipfs://test/1.json");
    }

    function test_SetBaseURI_UpdatesTokenURI() public {
        nft.setBaseURI("ipfs://new/");
        vm.prank(address(pool));
        nft.mint(alice, 1);
        assertEq(nft.tokenURI(1), "ipfs://new/1.json");
    }

    function test_TokenURI_Reverts_NonexistentToken() public {
        vm.expectRevert();
        nft.tokenURI(999);
    }

    // ── TRANSFER HOOK ──────────────────────────────────────
    function test_Mint_NotifiesPoolHook() public {
        // _update fires on mint too (from == address(0)).
        vm.prank(address(pool));
        nft.mint(alice, 1);

        assertTrue(pool.called(), "pool notified on mint");
        assertEq(pool.lastFrom(), address(0));
        assertEq(pool.lastTo(), alice);
    }

    function test_Transfer_NotifiesPoolHook() public {
        vm.prank(address(pool));
        nft.mint(alice, 1);

        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);

        assertEq(pool.lastFrom(), alice);
        assertEq(pool.lastTo(), bob);
        assertEq(nft.ownerOf(1), bob);
    }

    /// @dev The hook call is wrapped in try/catch — a misbehaving pool must
    ///      never brick NFT transfers (funds/positions always stay movable).
    function test_Transfer_SucceedsEvenIfPoolHookReverts() public {
        vm.prank(address(pool));
        nft.mint(alice, 1);

        pool.setShouldRevert(true);

        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);

        assertEq(nft.ownerOf(1), bob, "transfer succeeds despite hook revert");
    }
}
