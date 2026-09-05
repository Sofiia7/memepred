/**
 * usePlaceBet - Sprint 4.1 + 4.2
 *
 * 4.1: Decodes OrderPlaced from the receipt logs and exposes `orderId`. UI
 *      can redirect to /order/:address/:orderId immediately after confirm.
 * 4.2: Reads `market.feedId()` on-chain instead of using a global
 *      VITE_PYTH_FEED_ID. Per-market feeds are correct for multi-coin.
 */
import { useState, useCallback, useEffect } from 'react'
import {
  useWriteContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount,
  usePublicClient,
} from 'wagmi'
import { parseUnits, maxUint256, decodeEventLog, type Address, type Hash, encodeFunctionData } from 'viem'
import { CONTRACTS, ORDERBOOK_MARKET_ABI, ERC20_ABI, CURRENCY_DECIMALS } from '../lib/contracts'
import { getPendingReferrer } from '../lib/referral'
import { fetchBetPayload, withPayload } from '../lib/oracle'
import { useEnsureChain } from './useEnsureChain'

export type Direction = 0 | 1  // 0=UP, 1=DOWN

/**
 * Minimal ABI for quoting Pyth's update fee.
 *
 * Sprint 5.6: bets used to attach a flat 0.0001 ETH and rely on the contract
 * refunding the excess. Refunded or not, the wallet still had to be holding it
 * at send time - so a user with exactly enough ETH for gas simply could not
 * bet, and everyone else was asked to park ~$0.19 for no reason. Pyth's actual
 * fee on Base is 1 wei per update. Now we ask what it costs and send that.
 */
/** OracleResolver.pyth is immutable, so this is safe to resolve once. */
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
  referrer,
  expectedPrice,
  slippageBps = 100,
}: UsePlaceBetArgs) {

  const { address } = useAccount()

  // Resolved here rather than as a default parameter: the stored referrer has
  // to be compared against the connected wallet, and `address` doesn't exist
  // until useAccount() has run. Passing your own address as referrer is a hard
  // revert in the contract.
  const effectiveReferrer = referrer ?? getPendingReferrer(address)
  const publicClient = usePublicClient()
  const ensureChain = useEnsureChain()
  const [step, setStep] = useState<BetStep>('idle')
  const [error, setError] = useState<string>()
  const [orderId, setOrderId] = useState<bigint>()

  const amountWei = parseUnits(amountUsd || '0', CURRENCY_DECIMALS)

  // ── 4.2: per-market feedId from the market contract ───
  const { data: marketFeedId } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'feedId',
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, marketAddress],
    query: { enabled: !!address },
  })

  // The approval receipt is awaited inline in execute(), where the bet
  // actually has to stop and wait for it. A useWaitForTransactionReceipt here
  // watched the same hash and blocked nothing, which is how the bet came to be
  // sent against an allowance that had not landed.
  const { writeContractAsync: approve } = useWriteContract()

  const { sendTransactionAsync: sendBet, data: betTxHash } = useSendTransaction()
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
        // not an OrderPlaced log - skip
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
        const approveHash = await approve({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [marketAddress, maxUint256],
        })
        // Wait for it to land, not merely to be submitted.
        //
        // writeContractAsync resolves the moment the wallet accepts, so the
        // bet used to go out while the approval was still pending. Nonce
        // ordering would have executed them in the right order, but the
        // wallet estimates gas for the bet first and does not care about the
        // queue - the user gets "transfer amount exceeds allowance" on a bet
        // they were just told had been approved.
        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
          if (receipt.status !== 'success') {
            throw new Error('USDC approval failed on-chain - nothing was bet.')
          }
        }
        await refetchAllowance()
      }

      setStep('betting')

      // The strike has to come from a freshly signed oracle price, fetched
      // right now.
      //
      // This is not best-effort and has no fallback. Pricing a bet off the
      // keeper's last push meant the strike could be seconds stale - long
      // enough for anyone watching the oracle live to enter against a price
      // they already knew had moved - so the contract has no entry point that
      // accepts anything else. Failing here and asking the user to retry is
      // the correct outcome; placing their bet at a strike we know may be
      // wrong is worse.
      if (!marketFeedId) {
        throw new Error('Market price feed unavailable - cannot price this bet.')
      }

      let payload: `0x${string}`
      try {
        payload = await fetchBetPayload(marketFeedId)
      } catch (e: any) {
        throw new Error(
          `Couldn't fetch a live price (${e?.message ?? 'network error'}). ` +
          `Bets are priced from a fresh oracle update, so please try again in a moment.`,
        )
      }

      // sendTransaction with hand-built calldata, not writeContract: RedStone
      // reads the price from the tail of the calldata, and writeContract
      // encodes the call itself with nowhere to append. There is also no fee
      // to attach any more - RedStone verifies signatures inside our own
      // contract and charges nothing, so placeBet is not even payable.
      await sendBet({
        to: marketAddress,
        data: withPayload(
          encodeFunctionData({
            abi: ORDERBOOK_MARKET_ABI,
            functionName: 'placeBet',
            args: [direction, amountWei, effectiveReferrer, expectedPrice, BigInt(slippageBps)],
          }),
          payload,
        ),
      })

      setStep('confirmed')
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage || err?.message || 'Transaction failed')
    }
  }, [address, amountWei, allowance, direction, marketAddress, effectiveReferrer, expectedPrice, slippageBps, marketFeedId, approve, refetchAllowance, sendBet, ensureChain, publicClient])

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
