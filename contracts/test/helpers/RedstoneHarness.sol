// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Test doubles that trust RedStone's mock signer set.
 *
 * The production contracts inherit PrimaryProdDataServiceConsumerBase, which
 * authorises five specific RedStone signer addresses. Their private keys are
 * RedStone's, so a test cannot mint a payload those contracts will accept - the
 * only real payloads available are the ones captured live in RedstoneFixture,
 * which carry whatever the market happened to be doing at capture time.
 *
 * These harnesses override only `getAuthorisedSignerIndex`, swapping that
 * signer set for the mock one RedStone ships for exactly this purpose (the
 * standard Anvil accounts). Everything else - the 3-of-5 threshold, the
 * staleness windows, the decimal conversion, the calldata layout, all the
 * protocol logic - is the production code, unmodified and under test.
 *
 * The live-payload tests in RedstoneOracle.t.sol exercise the real signer set,
 * so the one thing overridden here is still covered somewhere.
 */

import "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";
import "../../src/OracleResolver.sol";
import "../../src/OrderbookMarket.sol";
import "../../src/MarketFactory.sol";

contract OracleResolverHarness is OracleResolver, AuthorisedMockSignersBase {
    function getAuthorisedSignerIndex(address signerAddress)
        public view override returns (uint8)
    {
        return getAuthorisedMockSignerIndex(signerAddress);
    }
}

contract OrderbookMarketHarness is OrderbookMarket, AuthorisedMockSignersBase {
    constructor(
        address _usdc,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        bytes32 _pythFeedId,
        uint256 _duration
    )
        OrderbookMarket(
            _usdc, _resolver, _liquidityPool, _feeDistributor,
            _referralRegistry, _multisig, _pythFeedId, _duration
        )
    {}

    function getAuthorisedSignerIndex(address signerAddress)
        public view override returns (uint8)
    {
        return getAuthorisedMockSignerIndex(signerAddress);
    }
}

/**
 * A factory whose clones are harness markets.
 *
 * The implementation has to be deployed by the factory itself, because
 * OrderbookMarket takes its `factory` immutable from msg.sender and gates
 * initialize() on it - so this overrides the deployment hook rather than
 * passing an address in.
 */
contract MarketFactoryHarness is MarketFactory {
    constructor(
        address _usdc,
        address _resolver,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        address _liquidityPool
    )
        MarketFactory(_usdc, _resolver, _feeDistributor, _referralRegistry, _multisig, _liquidityPool)
    {}

    function _deployMarketImplementation(
        address _usdc,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig
    ) internal override returns (address) {
        return address(new OrderbookMarketHarness(
            _usdc, _resolver, _liquidityPool, _feeDistributor,
            _referralRegistry, _multisig, bytes32(0), 0
        ));
    }
}
