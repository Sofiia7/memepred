import { createConfig, http } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { coinbaseWallet, metaMask, injected } from 'wagmi/connectors'
import { farcasterMiniApp } from './lib/farcasterConnector'
import {
  DEPLOYMENT,
  TARGET_CHAIN,
  TARGET_CHAIN_ID,
  robinhoodChain,
  robinhoodChainTestnet,
} from './lib/chain'

export { TARGET_CHAIN, TARGET_CHAIN_ID }

/**
 * Connectors, per chain rather than per app.
 *
 * Farcaster and Coinbase Smart Wallet stay on Base, where both are known to
 * work: the Mini App connector exposes a Farcaster host's provider, and
 * Coinbase's smart wallet has been the primary connector there. Neither is
 * confirmed on Robinhood Chain - Coinbase's SpendPermissionManager is not
 * deployed there, which is one of the pieces the smart wallet flow uses - so
 * that build offers MetaMask and whatever else is injected, and nothing that
 * would fail after the user has already committed to a connection.
 */
const connectors = DEPLOYMENT.poolBacked
  ? [metaMask(), injected()]
  : [
      // When running inside a Farcaster client this exposes the host's
      // EIP-1193 provider; outside one it fails silently and the next
      // connector is used.
      farcasterMiniApp(),
      coinbaseWallet({
        appName: 'FlipTheMeme',
        appLogoUrl: 'https://flipthememe.com/icon.png',
        preference: 'smartWalletOnly',
      }),
      metaMask(),
      injected(),
    ]

export const config = createConfig({
  chains: [TARGET_CHAIN],
  connectors,
  // Every chain the app can be built for gets a transport, not just the one
  // this build targets: wagmi wants the map keyed by chain id, and listing all
  // four keeps a network switch from landing on an undefined transport.
  transports: {
    [base.id]: http(import.meta.env.VITE_BASE_RPC_URL),
    [baseSepolia.id]: http('https://sepolia.base.org'),
    [robinhoodChain.id]: http(import.meta.env.VITE_RHC_RPC_URL),
    [robinhoodChainTestnet.id]: http(import.meta.env.VITE_RHC_RPC_URL),
  },
})
