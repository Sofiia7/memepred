import { useState, useCallback } from 'react'
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount
} from 'wagmi'
import { parseUnits, maxUint256, type Address } from 'viem'
import { CONTRACTS, ORDERBOOK_MARKET_ABI, ERC20_ABI } from '../lib/contracts'

export type Direction = 0 | 1  // 0=UP, 1=DOWN

interface UsePlaceBetArgs {
  marketAddress: Address
  direction:     Direction
  amountUsd:     string
  referrer?:     Address
  expectedPrice: bigint   // Pyth price at bet time
  slippageBps?:  number   // allowed slippage (default 50 = 0.5%)
}

type BetStep = 'idle' | 'approving' | 'approved' | 'betting' | 'confirmed' | 'error'

export function usePlaceBet({
  marketAddress,
  direction,
  amountUsd,
  referrer = '0x0000000000000000000000000000000000000000',
  expectedPrice,
  slippageBps = 100 // Default 1%
}: UsePlaceBetArgs) {

  const { address } = useAccount()
  const [step, setStep] = useState<BetStep>('idle')
  const [error, setError] = useState<string>()
  const [orderId, setOrderId] = useState<bigint>()

  const amountWei = parseUnits(amountUsd || '0', 6)

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi:     ERC20_ABI,
    functionName: 'allowance',
    args: [address!, marketAddress],
    query: { enabled: !!address }
  })

  const { writeContractAsync: approve, data: approveTxHash } = useWriteContract()

  useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: !!approveTxHash }
  })

  const { writeContractAsync: placeBet, data: betTxHash } = useWriteContract()

  useWaitForTransactionReceipt({
    hash: betTxHash,
    query: { enabled: !!betTxHash }
  })

  const execute = useCallback(async () => {
    if (!address || amountWei === 0n) return
    setError(undefined)

    try {
      if (!allowance || allowance < amountWei) {
        setStep('approving')
        await approve({
          address: CONTRACTS.USDC,
          abi:     ERC20_ABI,
          functionName: 'approve',
          args: [marketAddress, maxUint256]
        })
        await refetchAllowance()
      }

      setStep('betting')
      await placeBet({
        address:      marketAddress,
        abi:          ORDERBOOK_MARKET_ABI,
        functionName: 'placeBet',
        args: [direction, amountWei, referrer, expectedPrice, slippageBps]
      })

      setStep('confirmed')
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage || err?.message || 'Transaction failed')
    }
  }, [address, amountWei, allowance, direction, marketAddress, referrer, expectedPrice, slippageBps])

  return {
    execute,
    step,
    error,
    betTxHash,
    orderId,
    isLoading:   step === 'approving' || step === 'betting',
    isConfirmed: step === 'confirmed'
  }
}
