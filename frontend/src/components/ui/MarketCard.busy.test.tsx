import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MarketCardUI } from './MarketCard'
import { useBetBusyStore } from '../../hooks/useBetBusy'
import type { Market } from '../../hooks/useMarkets'

/**
 * Audit U01: while the Composer is placing a bet, the UP and DOWN buttons on
 * the card must not be able to change what is picked. The pick lives in each
 * page's own state, so the Composer publishes "busy" (useBetBusy) and the
 * buttons read it.
 */

vi.mock('../../hooks/useOdds', () => ({ useOdds: () => ({ upDepth: 3n, downDepth: 1n }) }))

const market: Market = {
  address: '0x00000000000000000000000000000000000000a1',
  feedId: '0x' + '00'.repeat(12) + 'aa'.repeat(20),
  feedSymbol: 'PEPE',
  duration: 300,
  openTime: 1,
  closeTime: null,
  entryPrice: 1,
  exitPrice: null,
  status: 'OPEN',
  upWon: null,
  upPool: 0,
  downPool: 0,
}

function renderCard(onPick = vi.fn()) {
  render(
    <MemoryRouter>
      <MarketCardUI symbol="PEPE" feedId={market.feedId} markets={[market]} picked={null} onPick={onPick} />
    </MemoryRouter>,
  )
  return onPick
}

const up = () => screen.getByRole('button', { name: /UP/ }) as HTMLButtonElement
const down = () => screen.getByRole('button', { name: /DOWN/ }) as HTMLButtonElement

beforeEach(() => useBetBusyStore.setState({ busy: false }))
afterEach(cleanup)

describe('MarketCardUI, UP and DOWN while a bet is being placed', () => {
  it('can pick when nothing is in flight', () => {
    const onPick = renderCard()
    fireEvent.click(up())
    fireEvent.click(down())
    expect(onPick).toHaveBeenCalledTimes(2)
  })

  it('cannot pick while the Composer is busy', () => {
    const onPick = renderCard()
    act(() => useBetBusyStore.setState({ busy: true }))

    expect(up().disabled).toBe(true)
    expect(down().disabled).toBe(true)
    fireEvent.click(up())
    fireEvent.click(down())
    expect(onPick).not.toHaveBeenCalled()
  })

  it('can pick again once the bet is done', () => {
    const onPick = renderCard()
    act(() => useBetBusyStore.setState({ busy: true }))
    act(() => useBetBusyStore.setState({ busy: false }))

    expect(up().disabled).toBe(false)
    fireEvent.click(down())
    expect(onPick).toHaveBeenCalledTimes(1)
  })
})
