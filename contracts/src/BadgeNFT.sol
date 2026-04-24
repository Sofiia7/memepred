// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title BadgeNFT
 * @notice Soulbound ERC-1155 бейджи. Нельзя передать, можно только минтить.
 *         Backend (MINTER_ROLE) минтит при выполнении условий.
 */
contract BadgeNFT is ERC1155, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public name   = "MemePred Badges";
    string public symbol = "MPBADGE";

    // badgeId → metadata
    struct BadgeInfo {
        string badgeName;
        string rarity; // "common" | "rare" | "epic" | "legendary"
        bool exists;
    }
    mapping(uint256 => BadgeInfo) public badges;

    event BadgeEarned(address indexed trader, uint256 indexed badgeId, string badgeName);

    constructor(string memory baseURI) ERC1155(baseURI) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _initBadgesA();
        _initBadgesB();
    }

    function _initBadgesA() internal {
        _registerBadge(1,  "Beginner",     "common");
        _registerBadge(2,  "On Fire",      "common");
        _registerBadge(3,  "Diamond",      "rare");
        _registerBadge(4,  "Sniper",       "rare");
        _registerBadge(5,  "Speed",        "common");
        _registerBadge(6,  "Whale",        "rare");
        _registerBadge(7,  "To The Moon",  "epic");
        _registerBadge(8,  "Oracle",       "epic");
    }

    function _initBadgesB() internal {
        _registerBadge(9,  "Legend",       "legendary");
        _registerBadge(10, "Champion",     "legendary");
        _registerBadge(11, "Pepe Master",  "common");
        _registerBadge(12, "Brett Fan",    "common");
        _registerBadge(13, "Pro",          "rare");
        _registerBadge(14, "Institutional","epic");
        _registerBadge(15, "Connector",    "rare");
        _registerBadge(16, "Network",      "epic");
    }

    // ── SOULBOUND ──────────────────────────────────────────
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        // Разрешить только минт (from == 0) и сжигание (to == 0)
        require(from == address(0) || to == address(0), "Soulbound: non-transferable");
        super._update(from, to, ids, values);
    }

    // ── MINT ───────────────────────────────────────────────
    function mintBadge(address to, uint256 badgeId) external onlyRole(MINTER_ROLE) {
        require(badges[badgeId].exists, "badge not found");
        require(balanceOf(to, badgeId) == 0, "already has badge");

        _mint(to, badgeId, 1, "");
        emit BadgeEarned(to, badgeId, badges[badgeId].badgeName);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function _registerBadge(uint256 id, string memory _name, string memory _rarity) internal {
        badges[id] = BadgeInfo({badgeName: _name, rarity: _rarity, exists: true});
    }

    function addMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(MINTER_ROLE, minter);
    }

    function removeMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(MINTER_ROLE, minter);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return string(abi.encodePacked(super.uri(tokenId), tokenId.toString(), ".json"));
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
