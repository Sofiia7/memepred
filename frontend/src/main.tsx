import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config } from './wagmi.config'
import { App } from './App'
import { assertEnv, MissingEnvError } from './lib/env'
import './index.css'

const queryClient = new QueryClient()

const root = ReactDOM.createRoot(document.getElementById('root')!)

// Sprint 4.5: refuse to render without addresses configured.
// Better a loud fatal screen than wallet calls into zero addresses.
try {
  assertEnv()
} catch (err) {
  if (err instanceof MissingEnvError) {
    root.render(<FatalEnvScreen missing={err.missing} />)
    throw err
  }
  throw err
}

root.render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)

function FatalEnvScreen({ missing }: { missing: string[] }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'JetBrains Mono, monospace',
      background: '#000', color: '#ff3355', padding: 24,
    }}>
      <div style={{ maxWidth: 540 }}>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>FLIPTHEMEME · CONFIG ERROR</div>
        <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>Frontend is not configured</h1>
        <p style={{ color: '#ccc', fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          One or more required environment variables are missing or invalid.
          Set them in <code style={{ color: '#fff' }}>.env</code> and rebuild.
        </p>
        <ul style={{ fontSize: 12, color: '#ffaa00', listStyle: 'none', padding: 0 }}>
          {missing.map((m) => (
            <li key={m} style={{ marginBottom: 4 }}>· {m}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
