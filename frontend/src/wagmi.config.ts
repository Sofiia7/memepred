import { createConfig, http } from 'wagmi'
import { base, baseSepolia }  from 'wagmi/chains'
import { coinbaseWallet, metaMask, injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [
    import.meta.env.VITE_NETWORK === 'mainnet' ? base : baseSepolia
  ],
  connectors: [
    coinbaseWallet({
      appName: 'MemePred',
      appLogoUrl: 'https://memepred.xyz/logo.png',
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
