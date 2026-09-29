import type { PriceStatus } from '../hooks/usePythPrice'

/**
 * What the Composer's main button says, and whether it may be pressed.
 *
 * Kept as a pure function of the state the Composer already has, so the rules
 * for "this bet must not be signed yet" live in one place with tests, instead
 * of being spread across a JSX `disabled` expression and a nested ternary for
 * the label.
 *
 * The order below is the order of precedence, and it is deliberate. The things
 * that make a signature wrong come first (a site built for a different
 * deployment than its API, a bet already being placed), then the things the
 * user can fix (balance, stake), then the things that merely have not arrived
 * yet (a live price, the fee), and only then the ordinary states. A button that
 * says RETRY next to a price that is ten minutes old would be inviting a bet
 * the app does not have a price for.
 */

export interface GateInput {
  isConnected: boolean
  /** A wrap or a bet is in progress. */
  busy: boolean
  /** usePlaceBet's step. */
  step: 'idle' | 'approving' | 'approved' | 'betting' | 'confirmed' | 'error'
  /** The stake is inside [MIN_BET, MAX_BET] and parses. */
  stakeOk: boolean
  /** The wallet holds less of the stake token than the stake. */
  insufficientBalance: boolean
  /** The price the bet would be signed against. */
  price: { status: PriceStatus; raw: bigint }
  /** The market's fee has been read (0 is a fee; "not read yet" is not). */
  feeReady: boolean
  feeFailed: boolean
  /** The site's env and its API describe different deployments. */
  deploymentMismatch: boolean
  /** Text for an error the last attempt ended with, already made friendly. */
  errorText?: string
  symbol: string
  side: 'up' | 'down'
  stake: number
}

export interface Gate {
  disabled: boolean
  label: string
  /** Why it is disabled, when the reason is one the UI may want to act on. */
  reason?: 'deployment' | 'busy' | 'placed' | 'balance' | 'price' | 'fee' | 'stake'
}

export function priceLabel(status: PriceStatus): string | null {
  switch (status) {
    case 'loading':
    case 'idle':
      return 'PRICE LOADING…'
    case 'unavailable':
      return 'PRICE UNAVAILABLE - RETRYING'
    case 'stale':
      return 'PRICE STALE - WAITING FOR A FRESH ONE'
    case 'live':
      return null
  }
}

export function composerGate(i: GateInput): Gate {
  // Connecting needs none of what follows, and is never blocked by it.
  if (!i.isConnected) return { disabled: i.busy, label: 'CONNECT WALLET', reason: i.busy ? 'busy' : undefined }

  if (i.deploymentMismatch) return { disabled: true, label: 'WRONG DEPLOYMENT - SIGNING OFF', reason: 'deployment' }

  if (i.step === 'approving') return { disabled: true, label: `APPROVING ${i.symbol}…`, reason: 'busy' }
  if (i.step === 'betting') return { disabled: true, label: 'PLACING BET…', reason: 'busy' }
  // Between the receipt and the redirect a press would place the same bet again.
  if (i.step === 'confirmed') return { disabled: true, label: 'PLACED ✓', reason: 'placed' }
  if (i.busy) return { disabled: true, label: 'WORKING…', reason: 'busy' }

  if (i.insufficientBalance) {
    return { disabled: true, label: `INSUFFICIENT ${i.symbol} - WRAP ETH FIRST`, reason: 'balance' }
  }

  const price = priceLabel(i.price.status)
  // `live` with a zero price cannot happen from usePythPrice, but the gate is
  // the last thing between a zero and expectedPrice, so it does not rely on it.
  if (price !== null || i.price.raw <= 0n) {
    return { disabled: true, label: price ?? 'PRICE UNAVAILABLE - RETRYING', reason: 'price' }
  }

  if (!i.feeReady) {
    return { disabled: true, label: i.feeFailed ? 'FEE UNAVAILABLE - RETRYING' : 'FEE LOADING…', reason: 'fee' }
  }

  if (i.step === 'error') {
    return { disabled: !i.stakeOk, label: 'RETRY · ' + (i.errorText ?? ''), reason: i.stakeOk ? undefined : 'stake' }
  }

  return {
    disabled: !i.stakeOk,
    label: `BUY ${i.side.toUpperCase()} · ${i.stake} ${i.symbol}`,
    reason: i.stakeOk ? undefined : 'stake',
  }
}
