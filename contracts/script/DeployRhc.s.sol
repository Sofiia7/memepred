// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolOrderbookMarket.sol";
import "../src/PoolMarketFactory.sol";
import "../src/PoolOracleResolver.sol";
import "../src/PoolLiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/BadgeNFT.sol";

/**
 * @title  DeployRhc
 * @notice One-shot deployment of the Robinhood Chain stack.
 *
 * @dev    A neighbour of Deploy.s.sol, which keeps deploying the Base stack.
 *         The shape is deliberately the same - deploy, wire, grant the
 *         operational roles, hand over - so that whatever is true of one
 *         deployment's role model is true of the other's.
 *
 *         Two things differ beyond the contract names.
 *
 *         **There is no feed whitelist to fill.** MarketFactory needs addFeed
 *         for every symbol before a market can exist; PoolMarketFactory admits
 *         any pool that passes its on-chain gates, so there is nothing to
 *         configure and no setMarketCreator, because creating a market needs no
 *         role at all.
 *
 *         **Handover is a decision rather than a step.** Deploy.s.sol always
 *         hands every role to the multisig and leaves the deployer powerless,
 *         which is right for a launch and wrong for a testnet soak: rehearsing
 *         the fee timelock, or opening a fee tier, needs an owner whose key we
 *         hold. So RHC_HANDOVER selects, and mainnet refuses to run without it -
 *         a deployment that silently kept an EOA as owner of the money is the
 *         failure this branch is least able to afford.
 */
contract DeployRhc is Script {
    struct Env {
        uint256 deployerKey;
        address deployer;
        address multisig;
        address treasury;
        address lpFeeSink;
        address nftRewards;
        address keeper;
        address badgeMinter;
        address weth;
        address v3Factory;
        bool handover;
    }

    function _envOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        return fallback_;
    }

    function _envBool(string memory key, bool fallback_) internal view returns (bool) {
        try vm.envBool(key) returns (bool b) {
            return b;
        } catch {}
        return fallback_;
    }

    function _loadEnv() internal view returns (Env memory e) {
        e.deployerKey = vm.envUint("PRIVATE_KEY");
        e.deployer = vm.addr(e.deployerKey);
        e.multisig = vm.envAddress("MULTISIG_ADDRESS");
        e.treasury = vm.envAddress("TREASURY_ADDRESS");
        e.lpFeeSink = vm.envAddress("LP_FEE_SINK_ADDRESS");
        e.nftRewards = vm.envAddress("NFT_REWARDS_ADDRESS");
        e.keeper = vm.envAddress("KEEPER_ADDRESS");
        e.badgeMinter = vm.envAddress("BADGE_MINTER_ADDRESS");

        // No defaults for these two. On mainnet they are the canonical WETH and
        // v3 factory; on the testnet neither contract exists at all, so a
        // default would be an address with no code that every gate then
        // reverts against, one confusing transaction at a time.
        e.weth = vm.envAddress("RHC_WETH_ADDRESS");
        e.v3Factory = vm.envAddress("RHC_V3_FACTORY_ADDRESS");

        e.handover = _envBool("RHC_HANDOVER", block.chainid == 4663);

        require(e.multisig != address(0), "MULTISIG_ADDRESS not set");
        require(e.multisig != e.deployer, "multisig must differ from deployer");
        require(e.weth.code.length > 0, "RHC_WETH_ADDRESS has no code on this chain");
        require(e.v3Factory.code.length > 0, "RHC_V3_FACTORY_ADDRESS has no code on this chain");
        require(block.chainid != 4663 || e.handover, "mainnet deployment must hand over to the multisig");
    }

    function run() external {
        Env memory e = _loadEnv();
        vm.startBroadcast(e.deployerKey);
        _deploy(e);
        vm.stopBroadcast();
    }

    function _deploy(Env memory e) internal {
        // ── 1. Deploy ────────────────────────────────────────
        FeeDistributor feeDistrib = new FeeDistributor(e.weth, e.treasury, e.lpFeeSink, e.nftRewards);
        ReferralRegistry referralReg = new ReferralRegistry();
        PoolOracleResolver resolver = new PoolOracleResolver(e.weth);
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://bafybeiez6a6hshxe22lkwhvbpjuiiw5ml4gup3sb2spc6nufiflrxbmcjm/");
        // PoolLiquidityPool, not LiquidityPool. The only difference is
        // MIN_DEPOSIT: upstream it is 50e6, meant as fifty USDC, which on an
        // eighteen-decimal stake token is 0.00000000005 and no floor at all.
        // That floor is the entire price of the twenty Genesis NFTs, each worth
        // 1.5x fee weight forever - without it they cost a gwei for the set.
        // See PoolLiquidityPool.t.sol, which runs the sweep on both.
        PoolLiquidityPool liquidityPool = new PoolLiquidityPool(IERC20(e.weth), address(genesisNFT));
        PoolMarketFactory factory = new PoolMarketFactory(
            e.weth,
            e.v3Factory,
            address(resolver),
            address(feeDistrib),
            address(referralReg),
            e.multisig,
            address(liquidityPool)
        );
        BadgeNFT badges = new BadgeNFT("ipfs://bafybeigqxdfu6uwvvkxn7kccsrufj7hhwd52564qsqmqxcibo5cqy3kyxy/");

        console.log("chainId:", block.chainid);
        console.log("PoolOracleResolver:", address(resolver));
        console.log("PoolMarketFactory:", address(factory));
        console.log("marketImplementation:", factory.marketImplementation());
        console.log("FeeDistributor:", address(feeDistrib));
        console.log("ReferralRegistry:", address(referralReg));
        console.log("GenesisNFT:", address(genesisNFT));
        console.log("PoolLiquidityPool:", address(liquidityPool));
        console.log("BadgeNFT:", address(badges));

        // ── 2. Wire (while the deployer is still owner) ──────
        genesisNFT.setLiquidityPool(address(liquidityPool));
        liquidityPool.setMarketFactory(address(factory));
        feeDistrib.setMarketFactory(address(factory));
        referralReg.setMarketFactory(address(factory));

        // ── 3. Operational roles, before any handover ────────
        // No setMarketCreator: on this factory creating a market needs no role.
        resolver.addKeeper(e.keeper);
        factory.setEmergencyPauser(e.keeper);
        badges.addMinter(e.badgeMinter);

        // ── 4. Handover ──────────────────────────────────────
        if (e.handover) {
            feeDistrib.transferOwnership(e.multisig);
            referralReg.transferOwnership(e.multisig);
            liquidityPool.transferOwnership(e.multisig);
            genesisNFT.transferOwnership(e.multisig);
            factory.transferOwnership(e.multisig);

            bytes32 ADMIN = 0x00; // DEFAULT_ADMIN_ROLE
            IAccessControl(address(resolver)).grantRole(ADMIN, e.multisig);
            IAccessControl(address(badges)).grantRole(ADMIN, e.multisig);
            IAccessControl(address(resolver)).renounceRole(ADMIN, e.deployer);
            IAccessControl(address(badges)).renounceRole(ADMIN, e.deployer);

            console.log("\n--- Handoff complete ---");
            console.log("multisig =", e.multisig);
            console.log("deployer (now powerless) =", e.deployer);
        } else {
            console.log("\n--- NO HANDOVER ---");
            console.log("deployer still owns everything:", e.deployer);
            console.log("Set RHC_HANDOVER=true to hand over. Mainnet refuses to deploy without it.");
        }

        console.log("\n--- Copy to .env ---");
        console.log("ORACLE_RESOLVER=%s", address(resolver));
        console.log("MARKET_FACTORY=%s", address(factory));
        console.log("FEE_DISTRIBUTOR=%s", address(feeDistrib));
        console.log("REFERRAL_REGISTRY=%s", address(referralReg));
        console.log("GENESIS_NFT=%s", address(genesisNFT));
        console.log("LIQUIDITY_POOL=%s", address(liquidityPool));
        console.log("BADGE_NFT=%s", address(badges));
        console.log("USDC_ADDRESS=%s", e.weth);
    }
}
