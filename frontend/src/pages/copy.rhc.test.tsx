import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { HowItWorksPage } from './HowItWorks'
import { TermsPage } from './Terms'

/**
 * What the Robinhood Chain build tells a trader, checked against what the
 * contracts do. The page copy is a set of promises, and these were wrong:
 * durations of "1m, 5m, 15m" everywhere (only 5m runs), a refund rule that
 * still said "retried until the price calms down" (a jump now refunds both
 * stakes at once), and "open-source" for contracts whose source is published
 * on the testnet explorer only.
 */

vi.mock('../lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chain')>()
  return {
    ...real,
    IS_POOL_BACKED: true,
    CURRENCY: { decimals: 18, symbol: 'WETH', minBet: '0.005', maxBet: '0.04', displayDecimals: 4 },
  }
})
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

/** The rendered text with every run of whitespace collapsed to one space. */
function pageText(ui: ReactElement) {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>)
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

afterEach(cleanup)

// The two characters this project never prints as a dash.
const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)

describe('How it works (Robinhood Chain)', () => {
  it('says the window is per market and that the demo runs 5 minutes', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain('over the window each market shows (the demo market runs 5 minutes)')
    expect(text).not.toMatch(/1m, 5m/)
    expect(text).not.toMatch(/1, 5, or 15/)
  })

  it('says the LP vault takes the other side only where it is enabled, otherwise another trader does', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain('On markets where the LP vault is enabled, the vault can take the other side of whatever is left')
    expect(text).toContain('on other markets that part waits for another trader')
  })

  it('says an unmatched order can be cancelled any time and is refunded automatically after 5 minutes', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain('cancel it any time, or after 5 minutes it stops matching and is refunded automatically')
  })

  it('describes the refund rules exactly: a price jump or missing history refunds both stakes at once, no fee', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain(
      'If the price jumps more than 2% at the end of the window, or the pool has no price history for it, both stakes are refunded immediately with no fee.',
    )
    // A pool with no liquidity is still retried, and refunded after 24h at the latest.
    expect(text).toContain('A pool with no liquidity at that moment is retried')
    expect(text).toContain('24 hours after the window ended, anyone can trigger the refund')
    expect(text).not.toMatch(/calms down/i)
  })

  it('says the source is on the testnet explorer, and that it is not audited', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain('The contract source is published on the Robinhood Chain testnet explorer.')
    expect(text).toContain('have not yet gone through an external security audit')
    expect(text).not.toMatch(/open-source/i)
  })

  it('uses no long dashes', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).not.toContain(EM_DASH)
    expect(text).not.toContain(EN_DASH)
  })
})

describe('Terms (Robinhood Chain)', () => {
  it('carries the date of this revision', () => {
    expect(pageText(<TermsPage />)).toContain('Last updated: 2026-09-29')
  })

  it('does not promise 1m, 5m and 15m windows everywhere; the window is set per market', () => {
    const text = pageText(<TermsPage />)
    expect(text).toContain('The window is set per market and shown on it (the demo market runs 5 minutes)')
    expect(text).not.toMatch(/1m, 5m|5m, 15m|1, 5, or 15/)
  })

  it('states the refund rules of the current contracts', () => {
    const text = pageText(<TermsPage />)
    expect(text).toContain('a price jump of more than 2% at the end of the window')
    expect(text).toContain('both stakes are refunded immediately, with no fee and no winner')
    // Oracle risk: what happens depends on why the price cannot be read.
    expect(text).toContain('the match is not settled: both stakes are refunded immediately, with no fee and no winner')
    expect(text).toContain('If the pool has no liquidity at that moment, settlement is skipped and retried')
    expect(text).toContain('24-hour grace period')
  })

  it('says a resting order can be cancelled, and is refunded automatically after 5 minutes', () => {
    const text = pageText(<TermsPage />)
    expect(text).toContain("You can cancel it yourself at any time; if you don't, it stops matching after 5 minutes and is refunded automatically.")
    expect(text).not.toContain("it's locked for up to")
  })

  it('still says the contracts are not audited', () => {
    expect(pageText(<TermsPage />)).toContain('have not undergone an external security audit')
  })

  it('uses no long dashes', () => {
    const text = pageText(<TermsPage />)
    expect(text).not.toContain(EM_DASH)
    expect(text).not.toContain(EN_DASH)
  })
})
