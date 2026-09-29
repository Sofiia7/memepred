import type { Address } from 'viem'
import { useOrderActions, type TxConfirmation } from './useOrderActions'

/**
 * Claim one order's winnings and follow the transaction to its receipt.
 *
 * A thin view over useOrderActions, which owns the state machine (awaiting
 * signature, submitted, confirmed, failed). `pending` now lasts until the
 * receipt instead of ending at the transaction hash, and `error` carries the
 * reason for a failure so callers have something to show - Portfolio used to
 * drop it.
 */
export function useClaim(marketAddress: Address, opts?: { onConfirmed?: (c: TxConfirmation) => void }) {
  const actions = useOrderActions(marketAddress, opts)
  return {
    claim: actions.claim,
    /** The transaction hash, once the wallet has broadcast it. */
    tx: actions.state.hash,
    pending: actions.isPending,
    error: actions.state.phase === 'failed' ? actions.state.error : undefined,
    /** The whole state, for <TxStatus>. */
    state: actions.state,
    reset: actions.reset,
  }
}
