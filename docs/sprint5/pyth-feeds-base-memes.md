# Pyth feeds × Base memecoins / Clanker alignment

Source: `GET https://hermes.pyth.network/v2/price_feeds?asset_type=crypto`
fetched at the start of Sprint 5.

Two tiers:

- **Tier A — Base-native memes & Base ecosystem.** Highest CEF relevance.
  Add these to `MarketFactory.addFeed()` immediately on the Sepolia soak.
- **Tier B — cross-chain memes tradable on Base.** Add after Tier A markets
  show traffic. Useful for "predict before listing on /clanker" angle.

If a token you want is missing here, search `https://www.pyth.network/developers/price-feed-ids` for the symbol; the registry is updated continuously.

---

## Tier A — Base-native (add first)

| Symbol | feedId (0x-prefixed) | Notes |
|---|---|---|
| BRETT  | `0x9b5729efe3d68e537cdcb2ca70444dea5f06e1660b562632609757076d0b9448` | Base meme, already in deploy script TODO list |
| TOSHI  | `0x3450d9fbb8c3cf749578315668e21fabb4cd78dcfda1c1cba698b804bae2db2a` | Base meme (Coinbase) |
| DEGEN  | `0x9c93e4a22c56885af427ac4277437e756e7ec403fbc892f975d497383bb33560` | Base, Farcaster-native |
| AERO   | `0x9db37f4d5654aad3e37e2e14ffd8d53265fb3026d1d8f91146539eebaa2ef45f` | Aerodrome (Base DEX) — high volume |
| MORPHO | `0x5b2a4c542d4a74dd11784079ef337c0403685e3114ba0d9909b5c7a7e06fdc42` | Base + multichain |
| WELL   | `0x3cf6bab8bf8041dc8ee2a3edebe16b5f9f4ff3cce46006aeb15c885ba4779d0b` | Moonwell (Base) |
| BAN    | `0xa6320c8329924601f4d092dd3f562376f657fa0b5d0cba9e4385a24aaf135384` | Comedian (Base meme) |
| B3     | `0xe9f7026d0e26b2643da0cc976bd6107d07092e11f2e4701f98a3c2ef45f0135a` | B3 token, Base ecosystem |
| MOBY   | `0xedbaef2120caa0cc107c332bc2e9ef79b51c80fa4bb746098015c5c366aec42f` | Moby AI on Base |
| AVNT   | `0xc4aa2587b3d35cd526b8e7827f78399d16c7861f719331869c07e5fa499606d0` | Avantis (Base perp DEX) |
| AIXBT  | `0x0fc54579a29ba60a08fdb5c28348f22fd3bec18e221dd6b90369950db638a5a7` | AIXBT by Virtuals (Base) |

## Tier B — cross-chain memes (tradable on Base bridges)

| Symbol | feedId | Notes |
|---|---|---|
| PEPE | `0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4` | already in Deploy.s.sol |
| DOGE | `0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c` | already in Deploy.s.sol |
| WIF (dogwifhat) | `0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc` | major meme |
| BONK | `0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419` | major Solana meme |
| FLOKI | `0x6b1381ce7e874dc5410b197ac8348162c0dd6c0d4c9cd6322672d6c2b1d58293` | |
| BABYDOGE | `0x053e0a17cc9282f191a6e60165dabd4a4861a8847c06eb34f54e07155eebedba` | |
| ELON (Dogelon) | `0xc9cf25cd0df326b7fb3548b37d38e1e5c6ba202188a44ad98b79335c2b202f7b` | |
| PONKE | `0xf4cb880742ecf6525885a239968914798c44cd83749856a6dff5c140ba5bf69b` | |
| MOTHER (IGGY) | `0x62742a997d01f7524f791fdb2dd43aaf0e567d765ebf8fd0406a994239e874d4` | |
| BOME (Book of Meme) | `0x30e4780570973e438fdb3f1b7ad22618b2fc7333b65c7853a7ca144c39052f7a` | |
| TURBO | `0xa00e67c6232f2f564932c252c440ed30759d10fee966b601c1613b0ed8692a5c` | |
| MEME | `0xcd2cee36951a571e035db0dfad138e6ecdb06b517cc3373cd7db5d3609b7927c` | Memecoin DAO |
| MOODENG | `0xffff73128917a90950cd0473fd2551d7cd274fd5a6cc45641881bbcc6ee73417` | |
| BODEN (Jeo Boden) | `0x7bd87c3390d2c88d4699c7621fd857e0982027723751ce6e98bcc7604a407976` | |
| ACT I | `0x4d716b908b470fabc1f9eeaf62ad32424b2388bf981401385df19ead98499c7c` | |
| ELIZAOS | `0x0e0fe74b2bc91e867d7f46757faf64c5a497c11515956d7016ae97493f5f6ff4` | AI / Virtuals ecosystem |
| MICHI | `0x63a45218d6b13ffd28ca04748615511bf70eff80a3411c97d96b8ed74a6decab` | |
| ZEREBRO | `0x3dd13bf483f196da0429b354db1fa4802ff6a5c19c559a6abdd9a92707f426dc` | |
| PUMP (Pump.fun) | `0x7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9` | the platform itself |
| HIPPO (SUDENG) | `0xf2c5249856da2fbe0221e163b3fed678dd6f76515ab933292dfb4f15a1de8f8c` | |
| HARRY-POTTER-OBAMA-SONIC-INU | `0xc5e0e0c92116c0c070a242b254270441a6201af680a33e0381561c59db3266c9` | Crypto.BITCOIN/USD per registry (yes really) |

## Marked DEPRECATED in Pyth — DO NOT add

`DOGINME`, `SKI`, `MANEKI`, `COQ INU`, `SENDCOIN`, `MYRO`, `LOOKSRARE`,
`BELIEVE`. Pyth keeps the IDs alive but staleness is a real risk.

---

## How to add a feed on Sepolia

```bash
# As multisig (or stand-in during the soak)
cast send $MARKET_FACTORY "addFeed(bytes32)" $FEED_ID \
  --rpc-url https://sepolia.base.org \
  --private-key $MULTISIG_STANDIN_KEY
```

`marketCreator` keeper will pick the new feed up on next tick (5 min) and
spawn markets for each duration.

## Clanker-specific tokens

Clanker tokens that don't have a Pyth feed yet:

- The vast majority. Pyth listing requires significant market cap + an
  exchange listing — most Clanker launches are too early-stage.

**Two-track plan for CEF activation:**

1. **Now (Sepolia soak)**: Use Tier A + a slice of Tier B. The "predict
   meme prices" angle works without Clanker-token-specific feeds.
2. **Post-grant (Sprint 6+)**: Add a fallback oracle for Clanker tokens
   without Pyth feeds. Options:
   - Reservoir/CoinGecko price API + multi-signature attestation (5 of 7)
   - Aerodrome pool TWAP (for tokens with deep Base liquidity)
   - The Graph subgraph indexing the Clanker trading contract directly

   Document this alt-oracle plan in the CEF application as the activation
   deliverable.
