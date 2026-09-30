import { describe, it, expect } from 'vitest'
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { POOL_ROUNDS_ABI } from './roundsAbi'
import { explainRoundError, revertName } from './roundErrors'

function reverted(errorName: string, args: readonly unknown[]) {
  const data = encodeErrorResult({ abi: POOL_ROUNDS_ABI, errorName: errorName as never, args: args as never })
  const cause = new ContractFunctionRevertedError({ abi: POOL_ROUNDS_ABI, data, functionName: 'bet' })
  return new BaseError('Execution reverted', { cause })
}

describe('explainRoundError', () => {
  it('names the contract errors a player can hit, in plain words', () => {
    expect(revertName(reverted('NotCollecting', [1n]))).toBe('NotCollecting')
    expect(explainRoundError(reverted('NotCollecting', [1n]))).toMatch(/Bets on this round are closed/)
    expect(explainRoundError(reverted('AlreadyBet', [1n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']))).toMatch(/one per wallet per round/)
    expect(explainRoundError(reverted('NotSettled', [1n]))).toMatch(/no result/)
    expect(explainRoundError(reverted('EnforcedPause', []))).toMatch(/paused/)
    expect(explainRoundError(reverted('BankTooLargeForPool', [60_000_000_000_000_000n, 40_000_000_000_000_000n]))).toMatch(/The pool's depth limits this round's bank/)
    expect(explainRoundError(reverted('PoolTooThin', [10n ** 19n]))).toMatch(/too little WETH right now to take bets/)
  })

  it('finds the name in plain text too, as some wallets pass it', () => {
    expect(explainRoundError(new Error('execution reverted: StakeOutOfBounds(1)'))).toMatch(/outside the contract's limits/)
  })

  it('says a rejection in the wallet sent nothing', () => {
    expect(explainRoundError({ code: 4001, message: 'User rejected the request.' })).toBe('Cancelled in your wallet - nothing was sent.')
  })

  it('falls back to a short raw message', () => {
    expect(explainRoundError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(240)
    expect(explainRoundError(undefined)).toBe('The transaction failed.')
  })
})
