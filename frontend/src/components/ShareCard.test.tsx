import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ShareCard } from './ShareCard'
import { TARGET_CHAIN } from '../lib/chain'

/**
 * A win shared from the testnet is not a win on mainnet: the text names the
 * chain the app is actually built for ("Robinhood Chain Testnet", "Base
 * Sepolia"), not a hard-coded product name.
 */

const MARKET = '0x00000000000000000000000000000000000000aa'

const writeText = vi.fn(async () => undefined)

beforeEach(() => {
  writeText.mockClear()
  vi.stubGlobal('navigator', { clipboard: { writeText }, share: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('ShareCard', () => {
  it('shares the amount, the direction and the name of the chain the app runs on', async () => {
    render(<ShareCard direction="UP" amount="0.01" payout="0.0196" marketAddress={MARKET} orderId={7n} />)

    fireEvent.click(screen.getByRole('button', { name: /share your win/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const shared = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(shared).toContain('Just won 0.0196')
    expect(shared).toContain('predicting UP on FlipTheMeme (staked 0.01')
    expect(shared).toContain(`on ${TARGET_CHAIN.name}.`)
    expect(shared).toContain(`/order/${MARKET}/7`)
  })

  it('confirms the copy on the button', async () => {
    render(<ShareCard direction="DOWN" amount="1" payout="2" marketAddress={MARKET} orderId={1n} />)
    fireEvent.click(screen.getByRole('button', { name: /share your win/i }))
    await waitFor(() => expect(screen.getByRole('button').textContent).toMatch(/copied to clipboard/i))
  })
})
