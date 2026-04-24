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

    constructor(string memory _baseURI) ERC721("MemePred Genesis", "MPGEN") Ownable(msg.sender) {
        baseTokenURI = _baseURI;
    }

    function mint(address to, uint256 number) external {
        require(msg.sender == liquidityPool, "only pool");
        require(totalMinted < MAX_SUPPLY,    "max supply");

        uint256 tokenId = ++totalMinted;
        genesisNumber[tokenId] = number;
        _mint(to, tokenId);

        emit GenesisMinted(to, tokenId, number);
    }

    function setLiquidityPool(address _pool) external onlyOwner {
        liquidityPool = _pool;
    }

    function setBaseURI(string memory _uri) external onlyOwner {
        baseTokenURI = _uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(baseTokenURI, Strings.toString(tokenId), ".json"));
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }
}
