import { createConfig, http } from 'wagmi'
import { base, baseSepolia }  from 'wagmi/chains'
import { coinbaseWallet, metaMask, injected } from 'wagmi/connectors'
import { farcasterMiniApp } from './lib/farcasterConnector'

const isMainnet = import.meta.env.VITE_NETWORK === 'mainnet'

// Single source of truth for "the chain this app runs on" - used by
// useEnsureChain to detect/prompt a wallet-side network switch before writes.
export const TARGET_CHAIN    = isMainnet ? base : baseSepolia
export const TARGET_CHAIN_ID = TARGET_CHAIN.id

export const config = createConfig({
  chains: [isMainnet ? base : baseSepolia],
  connectors: [
    // Farcaster Mini App: when running inside a Farcaster client, this connector
    // exposes the host's EIP-1193 provider. Outside Farcaster the connector
    // silently fails and the next one is used.
    farcasterMiniApp(),
    // Coinbase Smart Wallet - primary connector outside Farcaster.
    coinbaseWallet({
      appName:    'FlipTheMeme',
      appLogoUrl: 'https://flipthememe.com/icon.png',
      preference: 'smartWalletOnly'
    }),
    metaMask(),
    injected()
  ],
  transports: {
    [base.id]:        http(import.meta.env.VITE_BASE_RPC_URL),
    [baseSepolia.id]: http('https://sepolia.base.org')
  }
})
