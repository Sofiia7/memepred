// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

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

    event ReferralRegistered(address indexed referee, address indexed referrer);
    event RefCodeGenerated(address indexed referrer, bytes6 code);

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
    function generateCode(address referrer) external returns (bytes6 code) {
        require(referrerToCode[referrer] == bytes6(0), "code exists");

        code = bytes6(keccak256(abi.encodePacked(referrer, block.timestamp, blockhash(block.number - 1))));
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
    function authorizeMarket(address market) external onlyOwner {
        authorizedMarkets[market] = true;
    }

    function revokeMarket(address market) external onlyOwner {
        authorizedMarkets[market] = false;
    }
}
