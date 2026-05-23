import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { base, baseSepolia } from 'wagmi/chains'
import { MiniKitProvider } from '@coinbase/onchainkit/minikit'
import { config } from './wagmi.config'
import { App } from './App'
import './index.css'

const queryClient = new QueryClient()
const chain       = import.meta.env.VITE_NETWORK === 'mainnet' ? base : baseSepolia
const apiKey      = import.meta.env.VITE_CDP_PROJECT_ID as string | undefined

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MiniKitProvider apiKey={apiKey} chain={chain}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </MiniKitProvider>
  </React.StrictMode>
)
