import { useCallback, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { useEnsureChain } from './useEnsureChain'

/**
 * Whether the connected wallet is on the network this build trades on, and a
 * way to move it there.
 *
 * useEnsureChain only ran at the first signature, so a wallet that connected on
 * the wrong network got no hint of it until an approval or a bet was about to
 * be sent. This is what a persistent banner reads instead: known the moment the
 * wallet connects, and cleared by itself when the wallet is on the right chain.
 */
export function useWalletNetwork() {
  const { isConnected, chainId } = useAccount()
  const ensureChain = useEnsureChain()
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string>()

  // `chainId` is the wallet's own chain, defined even when it is one this app
  // has no configuration for (where wagmi's `chain` would be undefined).
  const wrong = isConnected && chainId !== undefined && chainId !== TARGET_CHAIN_ID

  const switchNow = useCallback(async () => {
    setSwitching(true)
    setError(undefined)
    try {
      const r = await ensureChain()
      if (!r.ok) setError(r.error ?? 'Could not switch network')
    } finally {
      setSwitching(false)
    }
  }, [ensureChain])

  // A failed attempt should not outlive the problem it was about.
  useEffect(() => {
    if (!wrong) setError(undefined)
  }, [wrong])

  return { wrong, walletChainId: chainId, switching, error, switchNow }
}
