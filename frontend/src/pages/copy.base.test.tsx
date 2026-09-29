import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { HowItWorksPage } from './HowItWorks'
import { TermsPage } from './Terms'

/**
 * The same pages on the Base build, which the Robinhood rewording must not
 * leak into: Base's contracts have no cancelOrder, no resolver refunds and a
 * different price source, so its copy keeps saying what it always said.
 */

vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

function pageText(ui: ReactElement) {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>)
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

afterEach(cleanup)

describe('How it works (Base build)', () => {
  it('keeps the Base wording', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).toContain("Choose UP or DOWN for a meme coin's USD price over a fixed window")
    expect(text).toContain('the RedStone oracle decides the winner')
    expect(text).toContain('the unmatched part can be refunded after 5 minutes')
    expect(text).toContain('Contracts are open-source but have not yet gone through an external security audit')
  })

  it('does not tell a Base trader about Robinhood Chain rules', () => {
    const text = pageText(<HowItWorksPage />)
    expect(text).not.toMatch(/Robinhood/)
    expect(text).not.toMatch(/price jumps/)
    expect(text).not.toMatch(/cancel it any time/)
  })
})

describe('Terms (Base build)', () => {
  it('carries the date of this revision too', () => {
    expect(pageText(<TermsPage />)).toContain('Last updated: 2026-09-29')
  })

  it('keeps the Base description and its counterparty wording', () => {
    const text = pageText(<TermsPage />)
    expect(text).toContain('over a fixed window (5 min to 24h)')
    expect(text).toContain("If nobody's on the other side and the LP pool can't cover you, your bet is refunded")
    expect(text).toContain('locked for up to 5 minutes')
    expect(text).not.toMatch(/You can cancel it yourself/)
  })
})
