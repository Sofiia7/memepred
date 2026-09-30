import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { RiskGate, isReadableBeforeAck } from './RiskDisclosure'

// The settlement paragraph only exists on pool-backed deployments, and the
// gate's numbers come from the contracts module, so both are pinned here.
vi.mock('../lib/contracts', () => ({
  MAX_BET: 0.04,
  CURRENCY_SYMBOL: 'WETH',
  IS_POOL_BACKED: true,
}))

const ACK_KEY = 'ftm_risk_ack_v1'

/** Stands in for the routed app: shows which path it was rendered at. */
function Page() {
  const { pathname } = useLocation()
  return <div data-testid="page">page at {pathname}</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RiskGate>
        <Page />
      </RiskGate>
    </MemoryRouter>,
  )
}

const gateVisible = () => screen.queryByText('Before you use this') !== null
const pageVisible = () => screen.queryByTestId('page') !== null

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('RiskGate does not hide the Terms (audit CJM, first visit)', () => {
  /**
   * The gate's own last paragraph says "Full detail in the Terms", and the
   * header has a "how it works" link, and clicking either used to change the
   * URL while the same gate stayed on top of it: the rules could not be read
   * before agreeing to them.
   */
  it('renders /terms before acknowledgement', () => {
    renderAt('/terms')
    expect(pageVisible()).toBe(true)
    expect(gateVisible()).toBe(false)
  })

  it('renders /how-it-works before acknowledgement', () => {
    renderAt('/how-it-works')
    expect(pageVisible()).toBe(true)
    expect(gateVisible()).toBe(false)
  })

  it('treats the path the way the router does: any case, trailing slash', () => {
    for (const p of ['/Terms', '/TERMS/', '/how-it-works/', '/How-It-Works']) {
      renderAt(p)
      expect(pageVisible()).toBe(true)
      expect(gateVisible()).toBe(false)
      cleanup()
    }
  })

  it('keeps the gate on every other route', () => {
    const gated = [
      '/',
      '/pools',
      '/market/0x00000000000000000000000000000000000000aa',
      '/order/0x00000000000000000000000000000000000000aa/1',
      '/leaderboard',
      '/portfolio',
      '/genesis',
      '/refer',
      // Look-alikes: neither is one of the two routes.
      '/terms/extra',
      '/termsx',
      '/how-it-works/order/1',
      '/terms-and-more',
    ]
    for (const p of gated) {
      renderAt(p)
      expect(gateVisible(), p).toBe(true)
      expect(pageVisible(), p).toBe(false)
      cleanup()
    }
  })

  it('lets the Terms link inside the gate through to the Terms', () => {
    renderAt('/')
    expect(gateVisible()).toBe(true)
    fireEvent.click(screen.getByRole('link', { name: 'Terms' }))
    expect(screen.getByTestId('page').textContent).toBe('page at /terms')
    expect(gateVisible()).toBe(false)
  })

  it('does not treat reading the Terms as acknowledging them', () => {
    renderAt('/terms')
    expect(localStorage.getItem(ACK_KEY)).toBeNull()
  })

  it('shows every route once acknowledged', () => {
    localStorage.setItem(ACK_KEY, '1')
    renderAt('/portfolio')
    expect(pageVisible()).toBe(true)
    expect(gateVisible()).toBe(false)
  })

  it('acknowledging on a gated route reveals that same route', () => {
    renderAt('/portfolio')
    fireEvent.click(screen.getByRole('button', { name: /I understand/ }))
    expect(localStorage.getItem(ACK_KEY)).toBe('1')
    expect(screen.getByTestId('page').textContent).toBe('page at /portfolio')
  })

  it('still gates when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    renderAt('/')
    expect(gateVisible()).toBe(true)
    spy.mockRestore()
  })
})

describe('the gate says which network this is', () => {
  /**
   * The gate covers the whole screen, shell included, and is the first thing a
   * new visitor sees - so the "this is a test network" label has to be on it
   * too, not only in the header they have not reached yet. (The test
   * environment builds for Base Sepolia, which is a testnet.)
   */
  it('carries the testnet pill', () => {
    renderAt('/')
    expect(screen.getByRole('status').textContent).toMatch(/SEPOLIA|TESTNET/)
  })
})

describe('isReadableBeforeAck', () => {
  it('is exactly the two static pages', () => {
    expect(isReadableBeforeAck('/terms')).toBe(true)
    expect(isReadableBeforeAck('/how-it-works')).toBe(true)
    expect(isReadableBeforeAck('/')).toBe(false)
    expect(isReadableBeforeAck('')).toBe(false)
    expect(isReadableBeforeAck('/market/0xabc')).toBe(false)
    expect(isReadableBeforeAck('/terms/../portfolio')).toBe(false)
  })
})

describe('the settlement paragraph matches what the contracts now do', () => {
  /**
   * Before the L02 fix a price jump at settlement was "retried until it comes
   * back in line, refunded after 24 hours". The window is fixed history, so
   * coming back in line changes nothing: the contracts now refund both stakes
   * at once. Only a pool with no liquidity at that moment is still retried.
   */
  const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

  it('says a jump or missing history refunds both stakes immediately, with no fee', () => {
    renderAt('/')
    expect(text()).toMatch(/jumps more than 2% at the end of the window/)
    expect(text()).toMatch(/history no longer covers it/)
    expect(text()).toMatch(/both stakes are refunded immediately, with no fee/)
  })

  it('on the rounds screen it says 1% is kept on a refund and never promises no fee there', () => {
    renderAt('/rounds')
    expect(text()).toMatch(/1% of the matched bank is kept/)
    expect(text()).toMatch(/returns every stake in full, with no fee/)
    expect(text()).not.toMatch(/both stakes are refunded immediately, with no fee/)
    cleanup()
    renderAt('/Rounds/')
    expect(text()).toMatch(/1% of the matched bank is kept/)
  })

  it('no longer claims settlement waits for the price to calm down', () => {
    renderAt('/')
    expect(text()).not.toMatch(/comes back in line/)
    expect(text()).not.toMatch(/retried automatically/)
    expect(text()).not.toMatch(/delays settlement/)
  })

  it('keeps the 24 hour refund, for a pool with no liquidity only', () => {
    renderAt('/')
    expect(text()).toMatch(/no liquidity at that moment is retried, and refunded after 24 hours at the latest/)
  })

  it('still states the cap and the unaudited warning', () => {
    renderAt('/')
    expect(text()).toContain('The smart contracts have not been audited.')
    expect(text()).toContain('capped at 0.04 WETH')
  })

  it('contains no long dashes', () => {
    renderAt('/')
    // Built from code points so this file does not itself contain the characters.
    for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]) {
      expect(text()).not.toContain(dash)
    }
  })
})
