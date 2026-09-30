import { describe, it, expect } from 'vitest'
import { betGate, type BetGateInput } from './betGate'

const READY: BetGateInput = {
  isConnected: true,
  rulesLoaded: true,
  rulesMismatch: false,
  paused: false,
  step: 'idle',
  alreadyIn: false,
  secondsLeft: 120,
  minSecondsLeft: 8,
  side: 'UP',
  stakeOk: true,
  limitsText: '0.005-0.04 WETH',
  insufficientWeth: false,
  poolTooThin: false,
  depthBlocked: false,
  acknowledged: true,
  stakeText: '0.01',
  symbol: 'WETH',
}

describe('betGate', () => {
  it('lets a ready bet through, naming the stake and the side', () => {
    expect(betGate(READY)).toEqual({ disabled: false, label: 'BET 0.01 WETH UP' })
  })

  it('asks to connect first, and that is pressable', () => {
    expect(betGate({ ...READY, isConnected: false })).toEqual({ disabled: false, label: 'CONNECT WALLET' })
  })

  it('refuses until the player confirms what the bet is on', () => {
    expect(betGate({ ...READY, acknowledged: false })).toEqual({ disabled: true, label: 'CONFIRM WHAT YOU BET ON FIRST' })
  })

  it('refuses when the texts do not describe the contract', () => {
    expect(betGate({ ...READY, rulesMismatch: true })).toEqual({ disabled: true, label: 'RULES OUT OF DATE - SIGNING OFF' })
  })

  it('refuses a second bet in the same round, a paused contract and a round about to close', () => {
    expect(betGate({ ...READY, alreadyIn: true }).label).toBe('YOU HAVE A BET IN THIS ROUND')
    expect(betGate({ ...READY, paused: true }).label).toBe('NEW BETS PAUSED')
    expect(betGate({ ...READY, secondsLeft: 7 }).label).toMatch(/BETS CLOSING/)
    expect(betGate({ ...READY, secondsLeft: 8 }).disabled).toBe(false)
  })

  it('refuses without a side, outside the limits, and without WETH', () => {
    expect(betGate({ ...READY, side: undefined }).label).toBe('PICK UP OR DOWN')
    expect(betGate({ ...READY, stakeOk: false }).label).toBe('STAKE 0.005-0.04 WETH')
    expect(betGate({ ...READY, insufficientWeth: true }).label).toBe('NOT ENOUGH WETH - WRAP FIRST')
  })

  it('refuses a pool below the depth gate, and a stake the pool depth cannot back', () => {
    expect(betGate({ ...READY, poolTooThin: true })).toEqual({ disabled: true, label: 'POOL TOO THIN FOR NEW BETS' })
    expect(betGate({ ...READY, depthBlocked: true })).toEqual({ disabled: true, label: 'POOL DEPTH LIMITS THIS ROUND - LOWER THE STAKE' })
  })

  it('stays locked while a transaction is in flight, and while the contract is unread', () => {
    for (const step of ['approving', 'betting', 'wrapping', 'claiming'] as const) expect(betGate({ ...READY, step }).disabled).toBe(true)
    expect(betGate({ ...READY, rulesLoaded: false }).disabled).toBe(true)
  })
})
