/**
 * usePlaceBet — Sprint 4.1 + 4.2
 *
 * 4.1: Decodes OrderPlaced from the receipt logs and exposes `orderId`. UI
 *      can redirect to /order/:address/:orderId immediately after confirm.
 * 4.2: Reads `market.pythFeedId()` on-chain instead of using a global
 *      VITE_PYTH_FEED_ID. Per-market feeds are correct for multi-coin.
 */
import { useState, useCallback, useEffect } from 'react'
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount,
  usePublicClient,
} from 'wagmi'
import { parseUnits, maxUint256, decodeEventLog, type Address, type Hash } from 'viem'
import { CONTRACTS, ORDERBOOK_MARKET_ABI, ERC20_ABI } from '../lib/contracts'
import { getPendingReferrer } from '../lib/referral'
import { useEnsureChain } from './useEnsureChain'

export type Direction = 0 | 1  // 0=UP, 1=DOWN

interface UsePlaceBetArgs {
  marketAddress: Address
  direction:     Direction
  amountUsd:     string
  referrer?:     Address
  expectedPrice: bigint
  slippageBps?:  number
}

type BetStep = 'idle' | 'approving' | 'approved' | 'betting' | 'confirmed' | 'error'

export function usePlaceBet({
  marketAddress,
  direction,
  amountUsd,
  referrer = getPendingReferrer(),
  expectedPrice,
  slippageBps = 100,
}: UsePlaceBetArgs) {

  const { address } = useAccount()
  const publicClient = usePublicClient()
  const ensureChain = useEnsureChain()
  const [step, setStep] = useState<BetStep>('idle')
  const [error, setError] = useState<string>()
  const [orderId, setOrderId] = useState<bigint>()

  const amountWei = parseUnits(amountUsd || '0', 6)

  // ── 4.2: per-market pythFeedId from the market contract ───
  const { data: marketFeedId } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'pythFeedId',
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, marketAddress],
    query: { enabled: !!address },
  })

  const { writeContractAsync: approve, data: approveTxHash } = useWriteContract()
  useWaitForTransactionReceipt({ hash: approveTxHash, query: { enabled: !!approveTxHash } })

  const { writeContractAsync: placeBet, data: betTxHash } = useWriteContract()
  const { data: betReceipt, isSuccess: betReceiptOk } = useWaitForTransactionReceipt({
    hash: betTxHash,
    query: { enabled: !!betTxHash },
  })

  // ── 4.1: decode OrderPlaced log → orderId state ───────────
  useEffect(() => {
    if (!betReceiptOk || !betReceipt) return
    for (const log of betReceipt.logs) {
      // We only care about logs emitted by the market we just called.
      if (log.address.toLowerCase() !== marketAddress.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: ORDERBOOK_MARKET_ABI,
          data: log.data,
          topics: log.topics,
        }) as any
        if (decoded.eventName === 'OrderPlaced') {
          setOrderId(decoded.args.orderId as bigint)
          break
        }
      } catch {
        // not an OrderPlaced log — skip
      }
    }
  }, [betReceiptOk, betReceipt, marketAddress])

  const execute = useCallback(async () => {
    if (!address || amountWei === 0n) return
    setError(undefined)
    setOrderId(undefined)

    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) {
        setStep('error')
        setError(chainCheck.error)
        return
      }

      if (!allowance || allowance < amountWei) {
        setStep('approving')
        await approve({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [marketAddress, maxUint256],
        })
        await refetchAllowance()
      }

      setStep('betting')

      // 4.2: fetch fresh Pyth VAA for THIS market's feedId, not a global one.
      //
      // Sprint 5.6: this is no longer best-effort. The contract's bare
      // placeBet() overload has been removed and an empty update array is
      // rejected, because pricing a bet off the keeper's last push meant the
      // strike could be seconds stale — long enough for anyone watching Hermes
      // live to enter against a price they already knew had moved. There is
      // therefore no fallback to fall back to: no fresh update, no bet.
      //
      // Failing here is the correct outcome. The alternative was placing the
      // user's bet at a strike we know may be wrong, which is worse than
      // asking them to retry.
      if (!marketFeedId) {
        throw new Error('Market price feed unavailable — cannot price this bet.')
      }

      let priceUpdateData: `0x${string}`[] = []
      const hermes = import.meta.env.VITE_PYTH_HERMES || 'https://hermes.pyth.network'
      try {
        const r = await fetch(
          `${hermes}/v2/updates/price/latest?ids[]=${marketFeedId}&encoding=hex&parsed=false`,
        )
        if (!r.ok) throw new Error(`Hermes responded ${r.status}`)
        const j = (await r.json()) as { binary: { data: string[] } }
        priceUpdateData = j.binary.data.map((h) =>
          (h.startsWith('0x') ? h : `0x${h}`) as `0x${string}`,
        )
      } catch (e: any) {
        throw new Error(
          `Couldn't fetch a live price (${e?.message ?? 'network error'}). ` +
          `Bets are priced from a fresh oracle update, so please try again in a moment.`,
        )
      }
      if (priceUpdateData.length === 0) {
        throw new Error('Price feed returned no update — please try again in a moment.')
      }

      await placeBet({
        address: marketAddress,
        abi: ORDERBOOK_MARKET_ABI,
        functionName: 'placeBetWithPyth',
        args: [direction, amountWei, referrer, expectedPrice, BigInt(slippageBps), priceUpdateData],
        value: 100_000_000_000_000n, // 0.0001 ETH buffer; contract refunds the excess
      })

      setStep('confirmed')
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage || err?.message || 'Transaction failed')
    }
  }, [address, amountWei, allowance, direction, marketAddress, referrer, expectedPrice, slippageBps, marketFeedId, approve, refetchAllowance, placeBet, ensureChain])

  return {
    execute,
    step,
    error,
    betTxHash,
    orderId, // Sprint 4.1: now populated after confirmation
    isLoading: step === 'approving' || step === 'betting',
    isConfirmed: step === 'confirmed',
  }
}
