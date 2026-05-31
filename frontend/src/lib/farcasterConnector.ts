import { createConnector } from 'wagmi'
import {
  getAddress, SwitchChainError, UserRejectedRequestError,
  type Address, type Hex
} from 'viem'

/**
 * Custom wagmi connector that uses Farcaster's `sdk.wallet.getEthereumProvider()`
 * when the app is running inside a Farcaster host (Warpcast, Base App, …).
 *
 * Outside a Farcaster host the connector returns gracefully and wagmi falls
 * through to the next configured connector.
 */
export function farcasterMiniApp() {
  type Provider = any
  let provider: Provider | undefined

  async function loadProvider(): Promise<Provider | undefined> {
    if (provider) return provider
    try {
      const { sdk } = await import('@farcaster/miniapp-sdk')
      const inHost  = await sdk.isInMiniApp()
      if (!inHost) return undefined
      provider = await sdk.wallet.getEthereumProvider()
      return provider
    } catch {
      return undefined
    }
  }

  return createConnector(() => ({
    id:   'farcasterMiniApp',
    name: 'Farcaster',
    type: 'farcasterMiniApp',

    async setup() { await loadProvider() },

    async connect(_params?: any): Promise<any> {
      const p = await loadProvider()
      if (!p) throw new UserRejectedRequestError(new Error('Not in a Farcaster Mini App'))
      const accounts = await p.request({ method: 'eth_requestAccounts' }) as string[]
      const chainIdHex = await p.request({ method: 'eth_chainId' }) as Hex
      return {
        accounts: accounts.map((a) => getAddress(a)) as readonly Address[],
        chainId:  Number.parseInt(chainIdHex, 16)
      }
    },

    async disconnect() { /* host manages lifecycle */ },

    async getAccounts() {
      const p = await loadProvider()
      if (!p) return []
      const accounts = await p.request({ method: 'eth_accounts' }) as string[]
      return accounts.map((a) => getAddress(a)) as readonly Address[]
    },

    async getChainId() {
      const p = await loadProvider()
      if (!p) return 0
      const id = await p.request({ method: 'eth_chainId' }) as Hex
      return Number.parseInt(id, 16)
    },

    async getProvider() { return (await loadProvider()) as any },

    async isAuthorized() {
      try {
        const p = await loadProvider()
        if (!p) return false
        const accounts = await p.request({ method: 'eth_accounts' }) as string[]
        return accounts.length > 0
      } catch { return false }
    },

    async switchChain({ chainId }) {
      const p = await loadProvider()
      if (!p) throw new SwitchChainError(new Error('Provider unavailable'))
      try {
        await p.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }]
        })
      } catch (e: any) {
        throw new SwitchChainError(e)
      }
      return { id: chainId } as any
    },

    onAccountsChanged(_accounts: string[]) { /* re-emit via wagmi automatically */ },
    onChainChanged(_chainId: string) {},
    onDisconnect() {}
  }))
}
