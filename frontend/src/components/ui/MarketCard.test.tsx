import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MarketCardUI } from './MarketCard'
import type { Market } from '../../hooks/useMarkets'

/**
 * A Robinhood Chain market has no close time (the API serves null): it lives
 * forever, and each match settles `duration` after it was made. The card called
 * countdownFrom(null) and printed "00:00" on every one of them, and gave no way
 * from the card to the market's own page.
 */

const NOW = 1_800_000_000
const FEED = '0x' + '00'.repeat(12) + 'aa'.repeat(20)

vi.mock('../../hooks/useOdds', () => ({ useOdds: () => ({ upDepth: 3n, downDepth: 1n }) }))

const market = (over: Partial<Market> = {}): Market => ({
  address: '0x00000000000000000000000000000000000000a1',
  feedId: FEED, feedSymbol: 'PEPE', duration: 300, openTime: NOW - 10, closeTime: null,
  entryPrice: 1, exitPrice: null, status: 'OPEN', upWon: null, upPool: 0, downPool: 0,
  ...over,
})

function renderCard(markets: Market[], onPick = vi.fn()) {
  return render(
    <MemoryRouter>
      <MarketCardUI symbol="PEPE" feedId={FEED} markets={markets} picked={null} onPick={onPick} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('MarketCardUI: continuous markets', () => {
  it('says "continuous" instead of a 00:00 countdown', () => {
    renderCard([market()])

    expect(screen.queryByText(/00:00/)).toBeNull()
    expect(screen.getByText('continuous')).toBeDefined()
    expect(screen.getByText('5m')).toBeDefined()
  })

  it('explains what the duration means for such a market, with the same wording as the market page', () => {
    renderCard([market({ duration: 900 })])
    expect(screen.getByText('Continuous market - each bet settles 15m after it is matched.')).toBeDefined()
  })

  it('treats an old API\'s 0 as "no close time" as well', () => {
    renderCard([market({ closeTime: 0 })])
    expect(screen.queryByText(/00:00/)).toBeNull()
    expect(screen.getByText('continuous')).toBeDefined()
  })

  it('still counts down a market that really has a close time', () => {
    renderCard([market({ closeTime: NOW + 10 })])

    expect(screen.getByText('⌁ 00:10')).toBeDefined()
    expect(screen.queryByText('continuous')).toBeNull()
    expect(screen.queryByText(/Continuous market/)).toBeNull()
  })
})

describe('MarketCardUI: the way to the market page', () => {
  it('links the title to /market/:address', () => {
    renderCard([market()])
    const link = screen.getByRole('link', { name: 'PEPE' })
    expect(link.getAttribute('href')).toBe('/market/0x00000000000000000000000000000000000000a1')
  })

  it('follows the duration tab that is selected', () => {
    renderCard([
      market({ address: '0x00000000000000000000000000000000000000a1', duration: 300 }),
      market({ address: '0x00000000000000000000000000000000000000a2', duration: 900 }),
    ])
    expect(screen.getByRole('link', { name: 'PEPE' }).getAttribute('href')).toBe('/market/0x00000000000000000000000000000000000000a1')

    fireEvent.click(screen.getByText('15m'))

    expect(screen.getByRole('link', { name: 'PEPE' }).getAttribute('href')).toBe('/market/0x00000000000000000000000000000000000000a2')
  })

  it('still lets a trader pick UP or DOWN from the card', () => {
    const onPick = vi.fn()
    renderCard([market()], onPick)
    fireEvent.click(screen.getByRole('button', { name: /up/i }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ side: 'up', durationSec: 300 }))
  })
})
