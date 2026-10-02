import type { TxStep } from './useRoundTx'

/**
 * What the bet button says and whether it may be pressed, as a pure function
 * (the Composer's composerGate pattern). The order is precedence: what makes a
 * signature wrong first, then what the player can fix, then the ordinary state.
 */
export interface BetGateInput {
  isConnected: boolean
  /** Contract values (limits, fees, timing) have been read. */
  rulesLoaded: boolean
  /** The contract's side cap differs from the one the texts describe. */
  rulesMismatch: boolean
  paused: boolean
  step: TxStep
  /** The player already has a bet in this round. */
  alreadyIn: boolean
  secondsLeft: number
  minSecondsLeft: number
  side?: 'UP' | 'DOWN'
  stakeOk: boolean
  /** e.g. "0.005-0.04 WETH" */
  limitsText: string
  insufficientWeth: boolean
  nativeEth?: boolean
  /** The pool is below the depth gate right now: the contract refuses every bet (PoolTooThin). */
  poolTooThin: boolean
  /** This stake would raise the round's bank past what the pool's depth backs (BankTooLargeForPool). */
  depthBlocked: boolean
  stakeText: string
  symbol: string
}

export interface BetGate {
  disabled: boolean
  label: string
}

export function betGate(i: BetGateInput): BetGate {
  if (!i.isConnected) return { disabled: false, label: 'CONNECT WALLET' }
  if (!i.rulesLoaded) return { disabled: true, label: 'READING THE CONTRACT…' }
  if (i.rulesMismatch) return { disabled: true, label: 'RULES OUT OF DATE - SIGNING OFF' }

  if (i.step === 'approving') return { disabled: true, label: `APPROVING ${i.symbol}…` }
  if (i.step === 'betting') return { disabled: true, label: 'PLACING BET…' }
  if (i.step === 'wrapping') return { disabled: true, label: 'WRAPPING…' }
  if (i.step === 'claiming') return { disabled: true, label: 'WORKING…' }

  if (i.paused) return { disabled: true, label: 'NEW BETS PAUSED' }
  if (i.alreadyIn) return { disabled: true, label: 'YOU HAVE A BET IN THIS ROUND' }
  if (i.poolTooThin) return { disabled: true, label: 'POOL TOO THIN FOR NEW BETS' }
  if (i.secondsLeft < i.minSecondsLeft) return { disabled: true, label: 'BETS CLOSING - WAIT FOR THE NEXT ROUND' }
  if (!i.side) return { disabled: true, label: 'PICK UP OR DOWN' }
  if (!i.stakeOk) return { disabled: true, label: `STAKE ${i.limitsText}` }
  if (i.depthBlocked) return { disabled: true, label: 'POOL DEPTH LIMITS THIS ROUND - LOWER THE STAKE' }
  if (i.insufficientWeth) return { disabled: true, label: i.nativeEth ? 'NOT ENOUGH ETH FOR STAKE AND GAS' : `NOT ENOUGH ${i.symbol} - WRAP FIRST` }
  return { disabled: false, label: `BET ${i.stakeText} ${i.symbol} ${i.side}` }
}
