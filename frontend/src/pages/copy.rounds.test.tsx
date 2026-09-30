import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { HowItWorksPage } from './HowItWorks'
import { TermsPage } from './Terms'

vi.mock('../lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chain')>()
  return {
    ...real,
    IS_POOL_BACKED: true,
    CURRENCY: { decimals: 18, symbol: 'WETH', minBet: '0.005', maxBet: '0.04', displayDecimals: 4 },
  }
})
vi.mock('../rounds/flag', () => ({ ROUNDS_ENABLED: true }))
vi.mock('../components/ui/AppShell', () => ({ ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2> }))

function textOf(page: ReactElement): string {
  const { container } = render(<MemoryRouter>{page}</MemoryRouter>)
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

afterEach(cleanup)

describe('Robinhood copy when rounds are published', () => {
  it('explains the separate models and the rounds refund before the continuous-market steps', () => {
    const text = textOf(<HowItWorksPage />)
    expect(text).toContain('Rounds on Robinhood Chain testnet')
    expect(text).toContain('Continuous markets')
    expect(text).toContain('1.96 times its matched stake')
    expect(text).toContain('A tie or an unpriceable active round returns the matched stakes minus 1%')
    expect(text).toContain('Collect to receive winnings or refunds')
  })

  it('states the rounds fees, timing and collection separately from continuous markets', () => {
    const text = textOf(<TermsPage />)
    expect(text).toContain('Last updated: 2026-09-30')
    expect(text).toContain('Continuous markets are non-custodial')
    expect(text).toContain('Rounds on Robinhood Chain testnet')
    expect(text).toContain('The contract keeps 2% of the matched bank when there is a winner')
    expect(text).toContain('On a tie or when an active round cannot be priced')
    expect(text).toContain('keeps 1% of the matched bank')
    expect(text).toContain('must call Collect for winnings and refunds')
    expect(text).toContain('Round oracle risk')
  })
})
