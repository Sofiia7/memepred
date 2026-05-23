// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/MarketFactory.sol";
import "../src/OracleResolver.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/BadgeNFT.sol";

contract Deploy is Script {
    // Base Mainnet
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;

    // Pyth feed IDs (Base mainnet) — see https://pyth.network/developers/price-feed-ids
    bytes32 constant FEED_PEPE = 0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4;
    bytes32 constant FEED_DOGE = 0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address multisig    = vm.envAddress("MULTISIG_ADDRESS");
        address treasury    = vm.envAddress("TREASURY_ADDRESS");
        address lpFeeSink   = vm.envAddress("LP_FEE_SINK_ADDRESS");   // distinct: LP-pool fees
        address nftRewards  = vm.envAddress("NFT_REWARDS_ADDRESS");   // distinct: badge / NFT rewards
        address keeper      = vm.envAddress("KEEPER_ADDRESS");
        address badgeMinter = vm.envAddress("BADGE_MINTER_ADDRESS");  // backend signer

        vm.startBroadcast(deployerKey);

        // 1. FeeDistributor — three distinct sinks
        FeeDistributor feeDistrib = new FeeDistributor(USDC, treasury, lpFeeSink, nftRewards);
        console.log("FeeDistributor:", address(feeDistrib));

        // 2. ReferralRegistry
        ReferralRegistry referralReg = new ReferralRegistry();
        console.log("ReferralRegistry:", address(referralReg));

        // 3. OracleResolver
        OracleResolver oracleResolver = new OracleResolver(PYTH);
        oracleResolver.addKeeper(keeper);
        console.log("OracleResolver:", address(oracleResolver));

        // 4. GenesisNFT
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://GENESIS_METADATA/");
        console.log("GenesisNFT:", address(genesisNFT));

        // 5. LiquidityPool (ERC4626 vault)
        LiquidityPool liquidityPool = new LiquidityPool(IERC20(USDC), address(genesisNFT));
        console.log("LiquidityPool:", address(liquidityPool));

        // 6. Wire GenesisNFT → LP
        genesisNFT.setLiquidityPool(address(liquidityPool));

        // 7. MarketFactory
        MarketFactory factory = new MarketFactory(
            USDC,
            address(oracleResolver),
            address(feeDistrib),
            address(referralReg),
            multisig,
            address(liquidityPool)
        );
        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);
        console.log("MarketFactory:", address(factory));

        // 8. Wire shared infra ↔ MarketFactory (one-time; required for atomic auth)
        liquidityPool.setMarketFactory(address(factory));
        feeDistrib.setMarketFactory(address(factory));
        referralReg.setMarketFactory(address(factory));

        // 9. BadgeNFT
        BadgeNFT badges = new BadgeNFT("ipfs://YOUR_IPFS_HASH/");
        badges.addMinter(badgeMinter);
        console.log("BadgeNFT:", address(badges));

        vm.stopBroadcast();

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
