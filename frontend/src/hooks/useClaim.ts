import { useState } from 'react'
import { useWriteContract, useAccount } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'

export function useClaim(marketAddress: Address) {
  const { address }                        = useAccount()
  const { writeContractAsync, data: tx }   = useWriteContract()
  const [error, setError]                  = useState<string>()
  const [pending, setPending]              = useState(false)

  async function claim(orderId: bigint) {
    if (!address) return
    setError(undefined)
    setPending(true)
    try {
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
