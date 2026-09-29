import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TxStatus } from './TxStatus'

/** The status line under every claim, cancel, refund and recovery. */

const HASH = `0x${'ab'.repeat(32)}` as const

afterEach(cleanup)

describe('TxStatus', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<TxStatus state={{ phase: 'idle' }} />)
    expect(container.firstChild).toBeNull()
  })

  it('asks for the signature, naming the action', () => {
    render(<TxStatus state={{ phase: 'awaiting-signature', label: 'Cancel' }} />)
    expect(screen.getByRole('status').textContent).toBe('Confirm the cancel in your wallet…')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('says it is waiting for a block once submitted, with the explorer link', () => {
    render(<TxStatus state={{ phase: 'submitted', label: 'Claim', hash: HASH }} />)
    expect(screen.getByRole('status').textContent).toMatch(/Claim submitted - waiting for it to be confirmed/)
    const link = screen.getByRole('link', { name: /view transaction/i })
    expect(link.getAttribute('href')).toMatch(new RegExp(`/tx/${HASH}$`))
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('confirms once the receipt is in', () => {
    render(<TxStatus state={{ phase: 'confirmed', label: 'Refund', hash: HASH }} />)
    expect(screen.getByRole('status').textContent).toMatch(/✓ Refund confirmed\./)
    expect(screen.getByRole('link', { name: /view transaction/i })).toBeDefined()
  })

  it('fails loudly, with the reason, as an alert', () => {
    render(<TxStatus state={{ phase: 'failed', label: 'Claim', error: 'There is nothing to claim on this order.' }} />)
    expect(screen.getByRole('alert').textContent).toBe('Claim failed: There is nothing to claim on this order.')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('a failure that has a hash still links to it (a revert is worth looking at)', () => {
    render(<TxStatus state={{ phase: 'failed', label: 'Claim', error: 'reverted', hash: HASH }} />)
    expect(screen.getByRole('link', { name: /view transaction/i })).toBeDefined()
  })

  it('uses the compact style when asked, for a row in a list', () => {
    render(<TxStatus state={{ phase: 'confirmed', label: 'Claim' }} compact />)
    expect(screen.getByRole('status').className).toContain('tx-compact')
  })

  it('has a sensible default label', () => {
    render(<TxStatus state={{ phase: 'failed', error: 'boom' }} />)
    expect(screen.getByRole('alert').textContent).toBe('Transaction failed: boom')
  })
})
