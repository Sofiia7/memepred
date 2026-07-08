import { useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { TARGET_CHAIN_ID } from '../wagmi.config'

/**
 * Wallets on the wrong network (e.g. Ethereum mainnet, or Base mainnet while
 * this deploy targets Sepolia) previously got an opaque "Transaction failed"
 * from the RPC. Call this before any write and bail out of the caller if it
 * doesn't resolve to true — the wallet handles the actual switch prompt.
 */
export function useEnsureChain() {
  const { chain } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  return useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (chain?.id === TARGET_CHAIN_ID) return { ok: true }
    try {
      await switchChainAsync({ chainId: TARGET_CHAIN_ID })
      return { ok: true }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.shortMessage || err?.message || 'Please switch your wallet network and try again',
      }
    }
  }, [chain?.id, switchChainAsync])
}
