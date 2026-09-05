// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/LiquidityPool.sol";
import "../src/PoolLiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockToken.sol";

/**
 * @notice The Genesis sweep, priced on both vaults.
 *
 * @dev    LiquidityPool's MIN_DEPOSIT is `50e6`, written and meant as fifty
 *         USDC. On a chain whose stake token has eighteen decimals the same
 *         integer is 0.00000000005 of it. Nothing reverts and nothing reads as
 *         wrong; the floor just stops existing, and with it the only thing that
 *         makes the twenty Genesis NFTs cost anything.
 *
 *         These tests run the sweep itself rather than asserting on the
 *         constant, because the constant is not the bug - what it lets somebody
 *         do is.
 */
contract PoolLiquidityPoolTest is Test {
    MockToken weth;
    GenesisNFT genesisBase;
    GenesisNFT genesisPool;
    LiquidityPool base;
    PoolLiquidityPool rhc;

    function setUp() public {
        weth = new MockToken("Wrapped Ether", "WETH", 18);

        genesisBase = new GenesisNFT("ipfs://test/");
        base = new LiquidityPool(IERC20(address(weth)), address(genesisBase));
        genesisBase.setLiquidityPool(address(base));

        genesisPool = new GenesisNFT("ipfs://test/");
        rhc = new PoolLiquidityPool(IERC20(address(weth)), address(genesisPool));
        genesisPool.setLiquidityPool(address(rhc));
    }

    /// @dev Sweep every Genesis NFT into throwaway addresses, paying `each` per
    ///      claim, and report what the whole set cost.
    function _sweep(LiquidityPool vault, uint256 each) internal returns (uint256 spent) {
        uint256 max = vault.GENESIS_MAX();
        weth.mint(address(this), each * max);
        weth.approve(address(vault), each * max);
        for (uint256 i = 0; i < max; i++) {
            vault.deposit(each, address(uint160(0xBEEF0000 + i)));
            spent += each;
        }
        assertEq(vault.genesisCount(), max, "sweep did not take every Genesis NFT");
    }

    // ── the hole ──────────────────────────────────────────

    function test_OnEighteenDecimals_TheDollarFloorBuysEveryGenesisNftForDust() public {
        uint256 spent = _sweep(base, base.MIN_DEPOSIT());

        // Twenty NFTs, each carrying 1.5x fee weight for the life of the vault,
        // for a millionth of a single minimum bet.
        assertEq(spent, 1_000_000_000, "the whole Genesis supply cost more than a gwei");
        assertLt(spent, 0.005 ether / 1_000_000, "not dust after all");
        assertTrue(base.isGenesis(address(uint160(0xBEEF0000))), "sweeper is not a Genesis LP");
    }

    // ── the fix ───────────────────────────────────────────

    function test_TheRhcVaultPricesTheSweepInWhatTheChainActuallyStakes() public {
        assertEq(rhc.MIN_DEPOSIT(), 0.05 ether, "floor is not ten stakes");
        uint256 spent = _sweep(rhc, rhc.MIN_DEPOSIT());
        assertEq(spent, 1 ether, "twenty Genesis NFTs should cost a whole WETH");
    }

    function test_DustIsRefusedByTheRhcVault() public {
        uint256 dust = base.MIN_DEPOSIT(); // enough upstream, nothing here
        weth.mint(address(this), dust);
        weth.approve(address(rhc), dust);
        vm.expectRevert(bytes("below min deposit"));
        rhc.deposit(dust, address(this));
    }

    function test_MintIsGatedToo_NotJustDeposit() public {
        // mint(shares, receiver) is the other way in, and it applies the same
        // floor. Shares are quoted in an empty vault at the decimals offset, so
        // ask for the share count that resolves to just under the minimum.
        uint256 shares = rhc.previewDeposit(rhc.MIN_DEPOSIT() - 1);
        weth.mint(address(this), 1 ether);
        weth.approve(address(rhc), 1 ether);
        vm.expectRevert(bytes("below min deposit"));
        rhc.mint(shares, address(this));
    }

    // ── the change is additive ────────────────────────────

    function test_UpstreamVaultKeepsItsOwnFloorExactly() public view {
        assertEq(base.MIN_DEPOSIT(), 50e6, "Base's floor moved");
    }

    function test_TheOverrideDoesNotTouchAnythingElse() public view {
        assertEq(rhc.GENESIS_MAX(), base.GENESIS_MAX());
        assertEq(rhc.GENESIS_BOOST_BPS(), base.GENESIS_BOOST_BPS());
        assertEq(rhc.GLOBAL_MAX_EXPOSURE_BPS(), base.GLOBAL_MAX_EXPOSURE_BPS());
        assertEq(rhc.PER_MARKET_MAX_EXPOSURE_BPS(), base.PER_MARKET_MAX_EXPOSURE_BPS());
        assertEq(rhc.FEE_BPS_ON_LP_WIN(), base.FEE_BPS_ON_LP_WIN());
    }
}
