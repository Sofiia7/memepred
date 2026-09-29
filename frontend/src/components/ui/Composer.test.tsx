import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

/**
 * The Composer on Robinhood Chain: what gates the confirm button (audit U02,
 * U03, U11), what it locks while a bet is in flight (U01), where it sends the
 * user afterwards, and the getting-started pieces a new wallet needs (faucet,
 * balances, the pre-sign rules).
 *
 * usePlaceBet and usePythPrice have their own tests; here they are stand-ins
 * whose state the tests set, so what is under test is the Composer's wiring.
 */

const h = vi.hoisted(() => ({
  account: { address: '0x00000000000000000000000000000000000000bb' as string | undefined, isConnected: true },
  reads: {} as Record<string, unknown>,
  readErrors: {} as Record<string, boolean>,
  eth: undefined as bigint | undefined,
  wrapCalls: [] as any[],
  /** When set, the wrap transaction hangs in the "wallet" until this resolves. */
  wrapHold: undefined as Promise<void> | undefined,
  execute: undefined as any,
  connect: undefined as any,
  bet: {} as any,
  price: {} as any,
  priceFeedArgs: [] as unknown[],
  betArgs: [] as any[],
  deployment: { status: 'verified', rpc: 'match', api: 'match', reasons: [] as string[] } as any,
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  usePublicClient: () => undefined,
  useReadContract: ({ functionName }: any) => ({
    data: h.reads[functionName],
    isError: h.readErrors[functionName] ?? false,
    refetch: async () => ({}),
  }),
  useWriteContract: () => ({
    writeContractAsync: async (args: any) => {
      h.wrapCalls.push(args)
      if (h.wrapHold) await h.wrapHold
      return '0xwraphash'
    },
  }),
  useBalance: () => ({ data: h.eth === undefined ? undefined : { value: h.eth }, refetch: async () => ({}) }),
}))

vi.mock('../../lib/chain', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/chain')>()
  const d = orig.resolveDeployment('rhc-testnet')
  return { ...orig, DEPLOYMENT: d, TARGET_CHAIN: d.chain, TARGET_CHAIN_ID: d.chain.id, CURRENCY: d.currency, IS_POOL_BACKED: true }
})
vi.mock('../../lib/env', () => ({ FAUCET_URL: 'https://faucet.test/rhc' }))
vi.mock('../../hooks/usePlaceBet', () => ({
  usePlaceBet: (args: any) => {
    h.betArgs.push(args)
    return h.bet
  },
}))
vi.mock('../../hooks/usePythPrice', () => ({
  usePythPrice: (feedId: unknown) => {
    h.priceFeedArgs.push(feedId)
    return h.price
  },
}))
vi.mock('../../hooks/useConnectWallet', () => ({ useConnectWallet: () => ({ connectWallet: (...a: unknown[]) => h.connect(...a) }) }))
vi.mock('../../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../../hooks/useDeploymentCheck', () => ({ useDeploymentCheck: () => h.deployment }))

import { Composer } from './Composer'
import { useBetBusyStore } from '../../hooks/useBetBusy'
import type { PickedBet } from './MarketCard'

const M1 = '0x00000000000000000000000000000000000000a1' as const
const M2 = '0x00000000000000000000000000000000000000a2' as const
const FEED = '0x00000000000000000000000000000000000000000000000000000000000000f1'

const pick = (over: Partial<PickedBet> = {}): PickedBet => ({
  marketAddress: M1,
  feedId: '', // the backend's field, empty until the markets list loads
  symbol: 'MOON',
  durationSec: 300,
  side: 'up',
  oddsPct: 0,
  ...over,
})

const livePrice = { raw: 10n ** 18n, display: 1, loading: false, stale: false, unavailable: false, status: 'live' }
const idleBet = () => ({
  execute: h.execute,
  step: 'idle',
  error: undefined,
  betTxHash: undefined,
  orderId: undefined,
  intent: undefined,
  busy: false,
  isLoading: false,
  isConfirmed: false,
})

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderComposer(picked: PickedBet | null = pick(), onClear = vi.fn()) {
  const ui = (p: PickedBet | null) => (
    <MemoryRouter initialEntries={['/']}>
      <Composer picked={p} onClear={onClear} />
      <Where />
    </MemoryRouter>
  )
  const utils = render(ui(picked))
  return { ...utils, onClear, again: (p: PickedBet | null) => utils.rerender(ui(p)) }
}

/** The most recent call's argument (Array.prototype.at is newer than this project's lib target). */
const lastOf = <T,>(a: T[]): T => a[a.length - 1]

const cta = () => screen.getByRole('button', { name: /^(BUY|PRICE|FEE|CONNECT|PLACING|APPROVING|PLACED|WRONG|INSUFFICIENT|RETRY|WORKING)/ })
const stakeInput = () => screen.getByLabelText(/stake in/i) as HTMLInputElement
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

beforeEach(() => {
  h.account = { address: '0x00000000000000000000000000000000000000bb', isConnected: true }
  h.reads = { feedId: FEED, feeBps: 100n, balanceOf: 10n ** 18n }
  h.readErrors = {}
  h.eth = 10n ** 18n
  h.wrapCalls = []
  h.wrapHold = undefined
  h.execute = vi.fn()
  h.connect = vi.fn()
  h.bet = idleBet()
  h.price = { ...livePrice }
  h.priceFeedArgs = []
  h.betArgs = []
  h.deployment = { status: 'verified', rpc: 'match', api: 'match', reasons: [] }
  useBetBusyStore.setState({ busy: false })
})
afterEach(cleanup)

describe('Composer, the confirm button waits for a price (audit U02)', () => {
  it('is enabled with a live price and a read fee, and places the bet when pressed', () => {
    renderComposer()
    const b = cta()
    expect(b.textContent).toContain('BUY UP · 0.01 WETH')
    expect((b as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(b)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['loading', 'PRICE LOADING…', 0n],
    ['unavailable', 'PRICE UNAVAILABLE - RETRYING', 0n],
    ['stale', 'PRICE STALE - WAITING FOR A FRESH ONE', 10n ** 18n],
  ])('is disabled while the price is %s', (status, label, raw) => {
    h.price = { ...livePrice, status, raw, loading: status === 'loading', stale: status === 'stale', unavailable: status === 'unavailable' }
    renderComposer()
    const b = cta() as HTMLButtonElement
    expect(b.textContent).toContain(label)
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('is disabled for a zero price', () => {
    h.price = { ...livePrice, raw: 0n }
    renderComposer()
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
  })

  it('reads the price for the feed the market reports on chain, not the backend field', () => {
    renderComposer(pick({ feedId: '' }))
    expect(lastOf(h.priceFeedArgs)).toBe(FEED)
  })

  it('has no feed to price until the market has reported one', () => {
    h.reads.feedId = undefined
    renderComposer(pick({ feedId: '0xsomethingfromthebackend' }))
    expect(lastOf(h.priceFeedArgs)).toBeUndefined()
  })

  it('passes the price it read into the bet as the expected price', () => {
    renderComposer()
    expect(lastOf(h.betArgs).expectedPrice).toBe(10n ** 18n)
  })

  it('offers to connect without waiting for a price', () => {
    h.account = { address: undefined, isConnected: false }
    h.price = { ...livePrice, status: 'loading', raw: 0n, loading: true }
    renderComposer()
    const b = screen.getByRole('button', { name: 'CONNECT WALLET' }) as HTMLButtonElement
    expect(b.disabled).toBe(false)
    fireEvent.click(b)
    expect(h.connect).toHaveBeenCalledTimes(1)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('is disabled for a stake outside the limits', () => {
    renderComposer()
    fireEvent.change(stakeInput(), { target: { value: '0.001' } })
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(stakeInput(), { target: { value: '0.5' } })
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(stakeInput(), { target: { value: '0.02' } })
    expect((cta() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Composer, the fee is unknown until it has been read (audit U03)', () => {
  it('says the fee is loading, not 0.00%, and keeps the button off', () => {
    h.reads.feeBps = undefined
    renderComposer()
    expect(text()).toContain('Protocol fee: loading…')
    expect(text()).not.toContain('0.00%')
    const b = cta() as HTMLButtonElement
    expect(b.textContent).toContain('FEE LOADING…')
    expect(b.disabled).toBe(true)
  })

  it('shows no payout range while the fee is unknown', () => {
    h.reads.feeBps = undefined
    renderComposer()
    expect(screen.getByText(/PAYOUT IF WON/).textContent).toContain('-')
    expect(screen.getByText(/PAYOUT IF WON/).textContent).not.toMatch(/WETH/)
  })

  it('says so when the fee could not be read', () => {
    h.reads.feeBps = undefined
    h.readErrors.feeBps = true
    renderComposer()
    expect(text()).toContain('Protocol fee: unavailable')
    expect((cta() as HTMLButtonElement).textContent).toContain('FEE UNAVAILABLE')
  })

  it('quotes the fee and the payout range once it has been read', () => {
    renderComposer() // 1% fee, 0.01 WETH stake
    expect(text()).toContain('Protocol fee: 1.00% on a win')
    expect(screen.getByText(/PAYOUT IF WON/).textContent).toContain('0.0196-0.0198 WETH')
  })

  it('treats a fee that has been read as 0 as a real 0.00%', () => {
    h.reads.feeBps = 0n
    renderComposer()
    expect(text()).toContain('Protocol fee: 0.00% on a win')
    expect((cta() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Composer, a different deployment than its API (audit U11)', () => {
  it('refuses to sign and says why', () => {
    h.deployment = { status: 'mismatch', rpc: 'match', api: 'mismatch', reasons: ['The API indexes a different market factory than the one this site is built for.'] }
    renderComposer()
    expect(text()).toContain('This site is configured for a different deployment than its API')
    const b = cta() as HTMLButtonElement
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('stays out of the way when the check could not be made', () => {
    h.deployment = { status: 'unverified', rpc: 'match', api: 'unknown', reasons: [] }
    renderComposer()
    expect(text()).not.toContain('different deployment')
    expect((cta() as HTMLButtonElement).disabled).toBe(false)
  })

  it('stays out of the way while it is still checking', () => {
    h.deployment = { status: 'checking', rpc: 'unknown', api: 'unknown', reasons: [] }
    renderComposer()
    expect((cta() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Composer, nothing can change while a bet is in flight (audit U01)', () => {
  const busyBet = () => ({ ...idleBet(), busy: true, isLoading: true, step: 'approving' })

  it('disables the stake input, the amount chips, CLEAR and the button', () => {
    h.bet = busyBet()
    renderComposer()

    expect(stakeInput().disabled).toBe(true)
    for (const chip of screen.getAllByRole('button', { name: /WETH$/ }).filter((b) => /^\d/.test(b.textContent ?? ''))) {
      expect((chip as HTMLButtonElement).disabled).toBe(true)
    }
    expect((screen.getByRole('button', { name: 'CLEAR' }) as HTMLButtonElement).disabled).toBe(true)
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not clear the pick while busy, and clears it when idle', () => {
    h.bet = busyBet()
    const { onClear, unmount } = renderComposer()
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR' }))
    expect(onClear).not.toHaveBeenCalled()
    unmount()

    h.bet = idleBet()
    const second = renderComposer()
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR' }))
    expect(second.onClear).toHaveBeenCalledTimes(1)
  })

  it('publishes busy for the UP/DOWN buttons to read, and releases it when done', () => {
    h.bet = busyBet()
    const { again } = renderComposer()
    expect(useBetBusyStore.getState().busy).toBe(true)

    h.bet = idleBet()
    again(pick())
    expect(useBetBusyStore.getState().busy).toBe(false)
  })

  it('releases busy when the Composer goes away mid-flight, so the buttons are not left disabled', () => {
    h.bet = busyBet()
    const { unmount } = renderComposer()
    expect(useBetBusyStore.getState().busy).toBe(true)
    unmount()
    expect(useBetBusyStore.getState().busy).toBe(false)
  })

  it('keeps showing, and placing, the bet that was started when the page changes its pick meanwhile', () => {
    const { again } = renderComposer(pick({ marketAddress: M1, side: 'up', symbol: 'MOON' }))
    expect(screen.getByText('MOON')).toBeTruthy()

    // The bet starts (busy), then the page hands over a different pick.
    h.bet = busyBet()
    again(pick({ marketAddress: M1, side: 'up', symbol: 'MOON' }))
    again(pick({ marketAddress: M2, side: 'down', symbol: 'CAT' }))

    expect(screen.getByText('MOON')).toBeTruthy()
    expect(screen.queryByText('CAT')).toBeNull()
    expect(screen.getByText('UP')).toBeTruthy()
    const last = lastOf(h.betArgs)
    expect(last.marketAddress).toBe(M1)
    expect(last.direction).toBe(0)

    // Once it is over, the composer follows the page again.
    h.bet = idleBet()
    again(pick({ marketAddress: M2, side: 'down', symbol: 'CAT' }))
    expect(screen.getByText('CAT')).toBeTruthy()
    expect(lastOf(h.betArgs).marketAddress).toBe(M2)
    expect(lastOf(h.betArgs).direction).toBe(1)
  })

  it('locks while a wrap is in progress too, and unlocks when it lands', async () => {
    h.reads.balanceOf = 0n // needs to wrap the whole stake
    h.eth = 10n ** 18n
    let release!: () => void
    h.wrapHold = new Promise<void>((resolve) => {
      release = resolve
    })
    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^WRAP/ }))
    })

    // The wallet is open on the wrap: nothing that changes the bet may move.
    expect(h.wrapCalls).toHaveLength(1)
    expect(stakeInput().disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'CLEAR' }) as HTMLButtonElement).disabled).toBe(true)
    expect(useBetBusyStore.getState().busy).toBe(true)

    await act(async () => {
      release()
    })
    expect(stakeInput().disabled).toBe(false)
    expect(useBetBusyStore.getState().busy).toBe(false)
  })
})

describe('Composer, the order page it sends the user to (audit U01)', () => {
  it('goes to the market the bet was sent to, not the one picked by the time it confirmed', () => {
    // The page has moved on to M2; the bet that just confirmed was for M1.
    h.bet = { ...idleBet(), step: 'confirmed', isConfirmed: true, orderId: 7n, intent: { marketAddress: M1 } }
    const { onClear } = renderComposer(pick({ marketAddress: M2 }))

    expect(screen.getByTestId('where').textContent).toBe(`/order/${M1}/7`)
    expect(onClear).toHaveBeenCalled()
  })

  it('goes there even when nothing is picked any more', () => {
    h.bet = { ...idleBet(), step: 'confirmed', isConfirmed: true, orderId: 9n, intent: { marketAddress: M1 } }
    renderComposer(null)
    expect(screen.getByTestId('where').textContent).toBe(`/order/${M1}/9`)
  })

  it('does not redirect before the order id is known, and clears the pick after a few seconds instead', () => {
    vi.useFakeTimers()
    try {
      h.bet = { ...idleBet(), step: 'confirmed', isConfirmed: true, orderId: undefined, intent: { marketAddress: M1 } }
      const { onClear } = renderComposer()
      expect(screen.getByTestId('where').textContent).toBe('/')
      expect(onClear).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(onClear).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Composer, a new wallet has a way in (Robinhood Chain)', () => {
  it('shows the WETH and the native ETH balance side by side', () => {
    h.reads.balanceOf = 20_000_000_000_000_000n // 0.02
    h.eth = 3_000_000_000_000_000n // 0.003
    renderComposer()
    expect(text()).toContain('WETH 0.02 · ETH 0.003')
  })

  it('links to the faucet when the wallet has no ETH', () => {
    h.eth = 0n
    renderComposer()
    const link = screen.getByRole('link', { name: 'Get test ETH' }) as HTMLAnchorElement
    expect(link.href).toBe('https://faucet.test/rhc')
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
  })

  it('does not nag about the faucet when there is ETH, or before the balance is known', () => {
    h.eth = 10n ** 18n
    renderComposer()
    expect(screen.queryByRole('link', { name: 'Get test ETH' })).toBeNull()
    cleanup()

    h.eth = undefined
    renderComposer()
    expect(screen.queryByRole('link', { name: 'Get test ETH' })).toBeNull()
  })

  it('says the sequence up front: wrap, approve, bet, up to 3 wallet confirmations', () => {
    renderComposer()
    expect(text()).toContain('Wrap ETH to WETH, approve, then bet: up to 3 wallet confirmations.')
  })

  it('offers to wrap what is missing, and asks the wallet for exactly that, on the target chain', async () => {
    h.reads.balanceOf = 4_000_000_000_000_000n // 0.004 of the 0.01 stake
    h.eth = 10n ** 18n
    renderComposer()
    const wrap = screen.getByRole('button', { name: 'WRAP 0.006 ETH' })
    await act(async () => {
      fireEvent.click(wrap)
    })
    expect(h.wrapCalls).toHaveLength(1)
    expect(h.wrapCalls[0].functionName).toBe('deposit')
    expect(h.wrapCalls[0].value).toBe(6_000_000_000_000_000n)
    expect(h.wrapCalls[0].account).toBe('0x00000000000000000000000000000000000000bb')
    expect(h.wrapCalls[0].chainId).toBe(46630)
  })

  it('warns when wrapping would leave too little ETH for gas', () => {
    h.reads.balanceOf = 0n
    h.eth = 10_300_000_000_000_000n // 0.0103 ETH, stake 0.01: 0.0003 would be left
    renderComposer()
    expect(text()).toContain('Wrapping this leaves about 0.0003 ETH for gas')
    expect(text()).toContain('Keep at least 0.0005 ETH')
  })

  it('does not warn when there is comfortably enough', () => {
    h.reads.balanceOf = 0n
    h.eth = 20_000_000_000_000_000n // 0.02 ETH
    renderComposer()
    expect(text()).not.toContain('for gas')
  })

  it('says when there is not enough ETH to wrap at all, links the faucet, and does not offer the wrap', () => {
    h.reads.balanceOf = 0n
    h.eth = 5_000_000_000_000_000n // 0.005 ETH, need 0.01
    renderComposer()
    expect(text()).toContain('Not enough ETH to wrap 0.01')
    expect(screen.getByRole('link', { name: 'Get test ETH' })).toBeTruthy()
    expect((screen.getByRole('button', { name: /^WRAP/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows no balances until a wallet is connected', () => {
    h.account = { address: undefined, isConnected: false }
    renderComposer()
    expect(text()).not.toContain('ETH 1')
    expect(screen.queryByRole('link', { name: 'Get test ETH' })).toBeNull()
  })
})

describe('Composer, what you are agreeing to (Robinhood Chain)', () => {
  it('has the block before the confirm button, collapsed by default on a small screen', () => {
    renderComposer()
    const toggle = screen.getByRole('button', { name: /What you are agreeing to/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/matched against another trader/)).toBeNull()

    // It sits above the confirm button in the document.
    const pos = toggle.compareDocumentPosition(cta())
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens to the five points, with this market\'s window', () => {
    renderComposer(pick({ durationSec: 900 }))
    fireEvent.click(screen.getByRole('button', { name: /What you are agreeing to/ }))

    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(list.textContent).toMatch(/another trader or, on markets where it is enabled, against the LP vault/)
    expect(list.textContent).toMatch(/within 5 minutes, the unmatched part is refunded/)
    expect(list.textContent).toMatch(/60 second average price/)
    expect(list.textContent).toMatch(/your 15m window/)
    expect(list.textContent).toMatch(/dropped from the queue/)
    expect(list.textContent).toMatch(/more than 2%/)
    expect(list.textContent).toMatch(/both stakes are refunded immediately with no fee/)
    expect(list.textContent).toMatch(/about a minute/)
  })

  it('opens by default where there is room for it', () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('640'), media: q, addEventListener() {}, removeEventListener() {} })) as any
    try {
      renderComposer()
      expect(screen.getByRole('button', { name: /What you are agreeing to/ }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      window.matchMedia = original
    }
  })

  it('no longer says the bet "waits for an opposite order"', () => {
    renderComposer()
    fireEvent.click(screen.getByRole('button', { name: /What you are agreeing to/ }))
    expect(text()).not.toContain('waits for an opposite order')
  })
})

describe('Composer, the stake field', () => {
  it('has a real label tied to the input', () => {
    renderComposer()
    const input = stakeInput()
    expect(input.id).toBeTruthy()
    const label = document.querySelector(`label[for="${input.id}"]`)
    expect(label).toBeTruthy()
    expect(label?.textContent).toContain('WETH')
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('offers the four chips and applies one', () => {
    renderComposer()
    fireEvent.click(screen.getByRole('button', { name: '0.04 WETH' }))
    expect(stakeInput().value).toBe('0.04')
    expect(cta().textContent).toContain('BUY UP · 0.04 WETH')
  })
})

describe('Composer, empty', () => {
  it('asks for a pick when there is none', () => {
    renderComposer(null)
    expect(text()).toContain('Tap UP or DOWN to place a bet')
  })
})
