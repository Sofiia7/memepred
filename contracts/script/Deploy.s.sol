// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/MarketFactory.sol";
import "../src/OracleResolver.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/BadgeNFT.sol";

/// @title  Deploy
/// @notice One-shot mainnet/sepolia deployment.
///         IMPORTANT: hands every owner / DEFAULT_ADMIN_ROLE over to the
///         multisig at the end and revokes deployer access. After this script
///         completes, the deployer key should be considered burned for any
///         admin operation on these contracts. Run VerifyRoles.s.sol against
///         the deployed addresses to assert the handoff was clean.
contract Deploy is Script {
    address constant DEFAULT_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant DEFAULT_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;

    bytes32 constant FEED_PEPE = 0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4;
    bytes32 constant FEED_DOGE = 0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c;

    function _envOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address a) { if (a != address(0)) return a; } catch {}
        return fallback_;
    }

    struct Env {
        uint256 deployerKey;
        address deployer;
        address multisig;
        address treasury;
        address lpFeeSink;
        address nftRewards;
        address keeper;
        address badgeMinter;
        address USDC;
        address PYTH;
    }

    function _loadEnv() internal view returns (Env memory e) {
        e.deployerKey = vm.envUint("PRIVATE_KEY");
        e.deployer    = vm.addr(e.deployerKey);
        e.multisig    = vm.envAddress("MULTISIG_ADDRESS");
        e.treasury    = vm.envAddress("TREASURY_ADDRESS");
        e.lpFeeSink   = vm.envAddress("LP_FEE_SINK_ADDRESS");
        e.nftRewards  = vm.envAddress("NFT_REWARDS_ADDRESS");
        e.keeper      = vm.envAddress("KEEPER_ADDRESS");
        e.badgeMinter = vm.envAddress("BADGE_MINTER_ADDRESS");
        e.USDC        = _envOr("USDC_ADDRESS", DEFAULT_USDC);
        e.PYTH        = _envOr("PYTH_ADDRESS", DEFAULT_PYTH);
        require(e.multisig != address(0),       "MULTISIG_ADDRESS not set");
        require(e.multisig != e.deployer,       "multisig must differ from deployer");
        require(e.USDC.code.length > 0,         "USDC has no code on this chain");
        require(e.PYTH.code.length > 0,         "PYTH has no code on this chain");
    }

    function run() external {
        Env memory e = _loadEnv();
        vm.startBroadcast(e.deployerKey);
        _deploy(e);
        vm.stopBroadcast();
    }

    function _deploy(Env memory e) internal {
        // ── 1. Deploy ────────────────────────────────────────
        FeeDistributor   feeDistrib    = new FeeDistributor(e.USDC, e.treasury, e.lpFeeSink, e.nftRewards);
        ReferralRegistry referralReg   = new ReferralRegistry();
        OracleResolver   oracleResolver = new OracleResolver(e.PYTH);
        GenesisNFT       genesisNFT    = new GenesisNFT("ipfs://GENESIS_METADATA/");
        LiquidityPool    liquidityPool = new LiquidityPool(IERC20(e.USDC), address(genesisNFT));
        MarketFactory    factory       = new MarketFactory(
            e.USDC, address(oracleResolver), address(feeDistrib),
            address(referralReg), e.multisig, address(liquidityPool)
        );
        BadgeNFT badges = new BadgeNFT("ipfs://YOUR_IPFS_HASH/");

        console.log("FeeDistributor:",   address(feeDistrib));
        console.log("ReferralRegistry:", address(referralReg));
        console.log("OracleResolver:",   address(oracleResolver));
        console.log("GenesisNFT:",       address(genesisNFT));
        console.log("LiquidityPool:",    address(liquidityPool));
        console.log("MarketFactory:",    address(factory));
        console.log("BadgeNFT:",         address(badges));

        // ── 2. Wire (must happen while deployer is still owner) ──
        genesisNFT.setLiquidityPool(address(liquidityPool));
        liquidityPool.setMarketFactory(address(factory));
        feeDistrib.setMarketFactory(address(factory));
        referralReg.setMarketFactory(address(factory));

        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);

        // Roles that should belong to operational (non-multisig) wallets BEFORE
        // we hand ownership over.
        oracleResolver.addKeeper(e.keeper);
        factory.setEmergencyPauser(e.keeper);
        factory.setMarketCreator(e.keeper);   // keeper auto-spawns markets on cron
        badges.addMinter(e.badgeMinter);

        // ── 3. Hand over to multisig ─────────────────────────
        // Ownable contracts: single-step transferOwnership.
        feeDistrib   .transferOwnership(e.multisig);
        referralReg  .transferOwnership(e.multisig);
        liquidityPool.transferOwnership(e.multisig);
        genesisNFT   .transferOwnership(e.multisig);
        factory      .transferOwnership(e.multisig);

        // AccessControl contracts: grant ADMIN to multisig, renounce as deployer.
        bytes32 ADMIN = 0x00; // DEFAULT_ADMIN_ROLE
        IAccessControl(address(oracleResolver)).grantRole(ADMIN, e.multisig);
        IAccessControl(address(badges))        .grantRole(ADMIN, e.multisig);
        IAccessControl(address(oracleResolver)).renounceRole(ADMIN, e.deployer);
        IAccessControl(address(badges))        .renounceRole(ADMIN, e.deployer);

        console.log("\n--- Handoff complete ---");
        console.log("multisig =", e.multisig);
        console.log("deployer (now powerless) =", e.deployer);
        console.log("Run: forge script script/VerifyRoles.s.sol --rpc-url $RPC --sig 'run(address,address,address,address,address,address,address,address)' <multisig> <feeDistrib> <referralReg> <oracleResolver> <genesisNFT> <liquidityPool> <factory> <badges>");

        console.log("\n--- Copy to .env ---");
        console.log("FEE_DISTRIBUTOR=%s",   address(feeDistrib));
        console.log("REFERRAL_REGISTRY=%s", address(referralReg));
        console.log("ORACLE_RESOLVER=%s",   address(oracleResolver));
        console.log("GENESIS_NFT=%s",       address(genesisNFT));
        console.log("LIQUIDITY_POOL=%s",    address(liquidityPool));
        console.log("MARKET_FACTORY=%s",    address(factory));
        console.log("BADGE_NFT=%s",         address(badges));
    }
}
