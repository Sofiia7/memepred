// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title GenesisNFT
 * @notice ERC-721 for the first 20 LP providers.
 *         Tradeable (unlike soulbound BadgeNFT).
 *         Grants boosted fee share (80% vs 50%) to the holder.
 *         Sold the NFT → sold the right to boosted fees.
 */
contract GenesisNFT is ERC721, Ownable {
    uint256 public constant MAX_SUPPLY = 20;
    uint256 public totalMinted;

    // tokenId → genesis number (1–20)
    mapping(uint256 => uint256) public genesisNumber;

    string public baseTokenURI;

    // Only LiquidityPool can mint
    address public liquidityPool;

    event GenesisMinted(address indexed to, uint256 tokenId, uint256 number);

    constructor(string memory baseURI_) ERC721("FlipTheMeme Genesis", "FTMGEN") Ownable(msg.sender) {
        baseTokenURI = baseURI_;
    }

    function mint(address to, uint256 number) external {
        require(msg.sender == liquidityPool, "only pool");
        require(totalMinted < MAX_SUPPLY, "max supply");

        uint256 tokenId = ++totalMinted;
        genesisNumber[tokenId] = number;
        _mint(to, tokenId);

        emit GenesisMinted(to, tokenId, number);
    }

    /**
     * @notice Name the pool that may mint. Settable once.
     * @dev    One-shot, matching LiquidityPool.setMarketFactory and
     *         FeeDistributor.setMarketFactory. This one was freely re-settable,
     *         and the pool is the sole minter: repointing it at an address the
     *         owner controls is a licence to mint Genesis NFTs, each of which
     *         carries a permanent 1.5x on the LP fee stream. MAX_SUPPLY bounds
     *         the damage, which made it owner-trust rather than an open door -
     *         but there was no reason for the gap.
     */
    function setLiquidityPool(address _pool) external onlyOwner {
        require(liquidityPool == address(0), "pool already set");
        require(_pool != address(0), "zero pool");
        liquidityPool = _pool;
    }

    function setBaseURI(string memory uri_) external onlyOwner {
        baseTokenURI = uri_;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(baseTokenURI, Strings.toString(tokenId), ".json"));
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    // ── GENESIS-AWARE TRANSFER ─────────────────────────────
    /**
     * @dev On every transfer (including mint and burn) notify the LiquidityPool
     *      so it can rebalance Genesis-boosted fee weights. Best-effort: a
     *      failed sync MUST NOT brick transfers — funds always stay safe.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (liquidityPool != address(0)) {
            try ILiquidityPoolGenesisHook(liquidityPool).onGenesisTransfer(from, to) {} catch {}
        }
    }
}

interface ILiquidityPoolGenesisHook {
    function onGenesisTransfer(address from, address to) external;
}
