import { useState } from 'react'
import { useWriteContract, useAccount } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { useEnsureChain } from './useEnsureChain'

export function useClaim(marketAddress: Address) {
  const { address }                        = useAccount()
  const { writeContractAsync, data: tx }   = useWriteContract()
  const ensureChain                        = useEnsureChain()
  const [error, setError]                  = useState<string>()
  const [pending, setPending]              = useState(false)

  async function claim(orderId: bigint) {
    if (!address) return
    setError(undefined)
    setPending(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) {
        setError(chainCheck.error)
        return
      }
      await writeContractAsync({
        address:      marketAddress,
        abi:          ORDERBOOK_MARKET_ABI,
        functionName: 'claim',
        args:         [orderId]
      })
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Claim failed')
    } finally {
      setPending(false)
    }
  }

  return { claim, tx, pending, error }
}
