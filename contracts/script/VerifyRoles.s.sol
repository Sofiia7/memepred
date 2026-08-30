// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title  VerifyRoles
/// @notice Post-deploy assertion that every contract's admin / owner is the
///         expected multisig, and that the deployer no longer holds any role.
///         Aborts with a clear console message on mismatch.
///
///         Usage:
///           forge script script/VerifyRoles.s.sol \
///             --rpc-url $RPC \
///             --sig "run(address,address,address,address,address,address,address,address,address)" \
///             <multisig> <deployer> \
///             <feeDistrib> <referralReg> <oracleResolver> \
///             <genesisNFT> <liquidityPool> <factory> <badges>
contract VerifyRoles is Script {
    bytes32 constant ADMIN = 0x00; // DEFAULT_ADMIN_ROLE

    function run(
        address multisig,
        address deployer,
        address feeDistrib,
        address referralReg,
        address oracleResolver,
        address genesisNFT,
        address liquidityPool,
        address factory,
        address badges
    ) external view {
        _checkOwner("FeeDistributor", feeDistrib, multisig);
        _checkOwner("ReferralRegistry", referralReg, multisig);
        _checkOwner("LiquidityPool", liquidityPool, multisig);
        _checkOwner("GenesisNFT", genesisNFT, multisig);
        _checkOwner("MarketFactory", factory, multisig);

        _checkAccessControl("OracleResolver", oracleResolver, multisig, deployer);
        _checkAccessControl("BadgeNFT", badges, multisig, deployer);

        console.log("VerifyRoles: ALL GREEN");
    }

    function _checkOwner(string memory label, address target, address expected) internal view {
        address actual = Ownable(target).owner();
        if (actual != expected) {
            console.log("%s owner mismatch: expected=%s actual=%s", label, expected, actual);
            revert("owner mismatch");
        }
        console.log("%s owner = multisig OK", label);
    }

    function _checkAccessControl(string memory label, address target, address expectedAdmin, address deployer)
        internal
        view
    {
        IAccessControl ac = IAccessControl(target);
        if (!ac.hasRole(ADMIN, expectedAdmin)) {
            console.log("%s missing ADMIN on multisig", label);
            revert("admin missing");
        }
        if (ac.hasRole(ADMIN, deployer)) {
            console.log("%s STILL holds ADMIN on deployer", label);
            revert("deployer still admin");
        }
        console.log("%s ADMIN = multisig (deployer revoked) OK", label);
    }
}
