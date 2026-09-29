import { useCallback, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import type { Address, Hash } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { explainTxError } from '../lib/txErrors'
import { useEnsureChain } from './useEnsureChain'

/**
 * Where a transaction is, from the click to the receipt.
 *
 *   idle -> awaiting-signature -> submitted -> confirmed
 *                    \-------------\------------> failed
 *
 * `submitted` is the state the old hooks ended in: writeContractAsync resolves
 * when the wallet has BROADCAST the transaction, not when it has been mined, so
 * "pending" used to stop at the hash, the button came back while the claim was
 * still in flight, and a transaction that reverted on chain looked like a
 * success.
 */
export type TxPhase = 'idle' | 'awaiting-signature' | 'submitted' | 'confirmed' | 'failed'

export interface TxState {
  phase: TxPhase
  /** What is being done, for the status line: "Claim", "Cancel", ... */
  label?: string
  hash?: Hash
  /** Set with phase 'failed'. Plain English; see lib/txErrors.ts. */
  error?: string
  /**
   * What the call was about: the market and the id it was given (an order id,
   * or a match id for a recovery). A list of orders shares one hook instance and
   * uses these to show the status under the row it belongs to.
   */
  market?: Address
  id?: bigint
}

export type OrderAction = 'claim' | 'cancelOrder' | 'refundExpired' | 'emergencyRefundMatch'

const ACTION_LABEL: Record<OrderAction, string> = {
  claim: 'Claim',
  cancelOrder: 'Cancel',
  refundExpired: 'Refund',
  emergencyRefundMatch: 'Recovery',
}

export interface TxConfirmation {
  action: OrderAction
  hash: Hash
  market: Address
  /** The order id (or, for a recovery, the match id) the call was made with. */
  id: bigint
}

const isPendingPhase = (phase: TxPhase) => phase === 'awaiting-signature' || phase === 'submitted'

/**
 * Send one of an order's write calls and follow it to its receipt.
 *
 * One transaction at a time per hook instance: a second call while one is
 * awaiting a signature or a receipt is ignored (returns false), which is what
 * keeps a double click from sending a second claim that reverts "already
 * claimed" after the first lands.
 *
 * `onConfirmed` fires once the receipt says success - the moment to refetch the
 * order, because the chain has changed and nothing else will say so.
 *
 * The market is fixed for a page about one order (`marketAddress`), or given per
 * call for a list that spans markets (the portfolio): every action takes an
 * optional market as its last argument.
 */
export function useOrderActions(marketAddress?: Address, opts?: { onConfirmed?: (c: TxConfirmation) => void }) {
  const { address: account } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const ensureChain = useEnsureChain()
  const [state, setState] = useState<TxState>({ phase: 'idle' })

  const inFlight = useRef(false)
  // Read at call time: the callback a page passes is a fresh closure on every
  // render, and a receipt can arrive many renders after the click.
  const onConfirmed = useRef(opts?.onConfirmed)
  onConfirmed.current = opts?.onConfirmed

  const send = useCallback(
    async (action: OrderAction, id: bigint, market?: Address): Promise<boolean> => {
      if (inFlight.current) return false
      const label = ACTION_LABEL[action]
      const target = market ?? marketAddress
      if (!target) return false
      const about = { market: target, id }
      if (!account) {
        setState({ phase: 'failed', label, error: 'Connect your wallet first.', ...about })
        return false
      }
      inFlight.current = true
      let hash: Hash | undefined
      try {
        setState({ phase: 'awaiting-signature', label, ...about })

        const chainCheck = await ensureChain()
        if (!chainCheck.ok) {
          setState({ phase: 'failed', label, error: chainCheck.error ?? 'Switch your wallet to the right network.', ...about })
          return false
        }

        hash = await writeContractAsync({
          address:      target,
          abi:          ORDERBOOK_MARKET_ABI,
          functionName: action,
          args:         [id],
        })
        setState({ phase: 'submitted', label, hash, ...about })

        // No client means no way to follow the transaction: reported like a
        // receipt that never came, rather than left "submitted" for ever with
        // every action on the page disabled.
        const receipt = publicClient
          ? await publicClient.waitForTransactionReceipt({ hash }).catch(() => null)
          : null
        if (!receipt) {
          setState({
            phase: 'failed',
            label,
            hash,
            error: "Couldn't confirm the transaction in time. It may still go through - check the explorer link before trying again.",
            ...about,
          })
          return false
        }

        if (receipt.status !== 'success') {
          setState({
            phase: 'failed',
            label,
            hash,
            error: 'The transaction was mined but reverted on chain, so nothing changed. Check the explorer link for the reason.',
            ...about,
          })
          return false
        }

        setState({ phase: 'confirmed', label, hash, ...about })
        onConfirmed.current?.({ action, hash, market: target, id })
        return true
      } catch (e) {
        setState({ phase: 'failed', label, hash, error: explainTxError(e, `${label} failed.`), ...about })
        return false
      } finally {
        inFlight.current = false
      }
    },
    [account, ensureChain, marketAddress, publicClient, writeContractAsync],
  )

  return {
    state,
    /** True from the click until the receipt (or a failure). Disable every action while it is. */
    isPending: isPendingPhase(state.phase),
    claim:         (orderId: bigint, market?: Address) => send('claim', orderId, market),
    /** cancelOrder: the unmatched remainder, trader only, at any time. */
    cancel:        (orderId: bigint, market?: Address) => send('cancelOrder', orderId, market),
    refundExpired: (orderId: bigint, market?: Address) => send('refundExpired', orderId, market),
    /** emergencyRefundMatch takes a MATCH id, not an order id. */
    recover:       (matchId: bigint, market?: Address) => send('emergencyRefundMatch', matchId, market),
    reset: () => setState({ phase: 'idle' }),
  }
}
