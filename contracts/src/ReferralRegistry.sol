// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IMarketRegistry.sol";

/**
 * @title ReferralRegistry
 * @notice On-chain реестр реферальных связей.
 *         Вызывается из авторизованных контрактов при первой ставке реферала.
 */
contract ReferralRegistry is Ownable {
    // referee → referrer (once set, forever)
    mapping(address => address) public referrerOf;
    mapping(address => address[]) public referralsOf;

    // refCode → referrer address
    mapping(bytes6 => address) public codeToReferrer;
    mapping(address => bytes6) public referrerToCode;

    // Authorized markets that can register referrals
    mapping(address => bool) public authorizedMarkets;

    // MarketFactory (set once); can authorize new markets without owner involvement.
    address public marketFactory;

    event ReferralRegistered(address indexed referee, address indexed referrer);
    event RefCodeGenerated(address indexed referrer, bytes6 code);
    event MarketFactorySet(address indexed factory);
    event MarketAuthorized(address indexed market);
    event MarketRevoked(address indexed market);

    constructor() Ownable(msg.sender) {}

    // ── MODIFIERS ──────────────────────────────────────────
    modifier onlyAuthorized() {
        require(authorizedMarkets[msg.sender] || msg.sender == owner(), "unauthorized");
        _;
    }

    // ── REGISTER ───────────────────────────────────────────
    /**
     * @notice Зарегистрировать связь реферер → реферал.
     */
    function register(address referee, address referrer) external onlyAuthorized {
        if (referrer == address(0)) return;
        if (referrerOf[referee] != address(0)) return; // already set
        require(referee != referrer, "self referral");

        referrerOf[referee] = referrer;
        referralsOf[referrer].push(referee);

        emit ReferralRegistered(referee, referrer);
    }

    // ── GENERATE CODE ──────────────────────────────────────
    /// @notice Audit fix (S4, 2026-07-05): only a referrer can generate their
    ///         own code — previously anyone could spend an arbitrary address's
    ///         one-time code slot without consent. Also guards against the
    ///         (astronomically unlikely, but non-zero in a 48-bit space)
    ///         event that two different referrers hash to the same code.
    function generateCode(address referrer) external returns (bytes6 code) {
        require(msg.sender == referrer, "only self");
        require(referrerToCode[referrer] == bytes6(0), "code exists");

        code = bytes6(keccak256(abi.encodePacked(referrer, block.timestamp, blockhash(block.number - 1))));
        require(codeToReferrer[code] == address(0), "code collision, retry");
        codeToReferrer[code] = referrer;
        referrerToCode[referrer] = code;

        emit RefCodeGenerated(referrer, code);
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getReferrer(address referee) external view returns (address) {
        return referrerOf[referee];
    }

    function getReferralCount(address referrer) external view returns (uint256) {
        return referralsOf[referrer].length;
    }

    function resolveCode(bytes6 code) external view returns (address) {
        return codeToReferrer[code];
    }

    // ── ADMIN ──────────────────────────────────────────────
    function setMarketFactory(address _factory) external onlyOwner {
        require(marketFactory == address(0), "factory already set");
        require(_factory != address(0), "zero factory");
        marketFactory = _factory;
        emit MarketFactorySet(_factory);
    }

    /**
     * @notice Let a market record referrals.
     * @dev    The address has to be one the factory actually created. An
     *         authorized address can call register(victim, attacker) and pin a
     *         referral link on anyone, skimming their referral share from then
     *         on. Owner-gated, so this bounds an owner-key compromise rather
     *         than closing an open door - matching LiquidityPool and
     *         FeeDistributor, which are guarded the same way.
     */
    function authorizeMarket(address market) external {
        require(msg.sender == marketFactory || msg.sender == owner(), "only factory or owner");
        require(market != address(0), "zero market");
        require(marketFactory != address(0), "factory not set");
        require(IMarketRegistry(marketFactory).isMarket(market), "not a market");
        authorizedMarkets[market] = true;
        emit MarketAuthorized(market);
    }

    function revokeMarket(address market) external onlyOwner {
        authorizedMarkets[market] = false;
        emit MarketRevoked(market);
    }
}
