import type { TxState } from '../hooks/useOrderActions'
import { explorerTxUrl } from '../lib/explorer'
import '../order.css'

/**
 * The one line that says where a claim, cancel, refund or recovery is:
 * waiting for the wallet, broadcast and waiting for a block, done, or failed
 * with the reason. Every state that has a transaction hash links to it on the
 * chain's explorer, so a user is never left guessing whether something was sent.
 */
export function TxStatus({ state, compact = false }: { state: TxState; compact?: boolean }) {
  if (state.phase === 'idle') return null

  const label = state.label ?? 'Transaction'
  const url = state.hash ? explorerTxUrl(state.hash) : undefined
  const link = url ? (
    <a href={url} target="_blank" rel="noreferrer">View transaction ↗</a>
  ) : null
  const cls = `tx-status tx-${state.phase}${compact ? ' tx-compact' : ''}`

  if (state.phase === 'awaiting-signature') {
    return (
      <div className={cls} role="status">
        Confirm the {label.toLowerCase()} in your wallet…
      </div>
    )
  }
  if (state.phase === 'submitted') {
    return (
      <div className={cls} role="status">
        {label} submitted - waiting for it to be confirmed…{link}
      </div>
    )
  }
  if (state.phase === 'confirmed') {
    return (
      <div className={cls} role="status">
        ✓ {label} confirmed.{link}
      </div>
    )
  }
  return (
    <div className={cls} role="alert">
      {label} failed: {state.error ?? 'unknown error'}{link}
    </div>
  )
}
