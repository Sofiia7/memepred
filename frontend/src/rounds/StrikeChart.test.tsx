import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StrikeChart } from './StrikeChart'
import { usePoolTicks } from './usePoolTicks'
import { T_POOL, T_TIMES } from './testFixtures'

vi.mock('./usePoolTicks', () => ({ usePoolTicks: vi.fn(() => []) }))
afterEach(cleanup)
describe('contract ticks and chart orientation agree', () => {
  it.each([true, false])('shows DOWN as a negative exit for WETH token0=%s', (wethIsToken0) => {
    render(<StrikeChart pool={T_POOL} wethIsToken0={wethIsToken0} symbol="PEPE" times={T_TIMES} now={T_TIMES.settleAt+5} strikeFixed entryTick={0} exitTick={wethIsToken0 ? 25 : -25} outcome={2} mySide="DOWN" />)
    expect(screen.getByText(/Exit -0.25% vs strike: DOWN won/)).toBeTruthy()
  })
  it('compares signed live samples with the signed fixed strike', () => {
    vi.mocked(usePoolTicks).mockReturnValueOnce([{ t: T_TIMES.strikeEnd+10, tick: -980 }])
    render(<StrikeChart pool={T_POOL} wethIsToken0 symbol="PEPE" times={T_TIMES} now={T_TIMES.strikeEnd+10} strikeFixed entryTick={1000} exitTick={0} outcome={0} mySide="UP" />)
    expect(screen.getByText('now +0.20% vs strike')).toBeTruthy()
  })
})
