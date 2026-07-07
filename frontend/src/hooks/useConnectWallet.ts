import { useConnect } from 'wagmi'
import { isInMiniApp } from '../lib/miniapp'

/**
 * connectors[0] is farcasterMiniApp — only usable inside a Farcaster/Base App
 * host. Outside one its connect() throws (no auto fallthrough to the next
 * connector), so a naive connectors[0] click silently does nothing in a
 * regular browser. This picks the right connector for the current context.
 */
export function useConnectWallet() {
  const { connect, connectors } = useConnect()

  async function connectWallet() {
    const inMiniApp = await isInMiniApp()
    const target = inMiniApp
      ? connectors.find((c) => c.id === 'farcasterMiniApp')
      : connectors.find((c) => c.id !== 'farcasterMiniApp')
    if (target) connect({ connector: target })
  }

  return { connectWallet }
}
