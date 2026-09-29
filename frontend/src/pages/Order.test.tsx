import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { getAddress } from 'viem'
import { OrderPage } from './Order'

/**
 * The order page: what it does with a bad link, an order that is not there, and
 * the transactions it starts.
 *
 * The page sat on "Loading order..." for ever for an order that did not exist,
 * accepted any string as a market address, and ended every claim, refund and
 * recovery at the transaction hash. The status card itself is stubbed here (it
 * has its own suite); what is under test is the page around it.
 */

const MARKET = '0x00000000000000000000000000000000000000aa'
const TRADER = '0x00000000000000000000000000000000000000bb'
const ZERO = '0x0000000000000000000000000000000000000000'

let orderRead: { data?: { trader: string }; isError?: boolean }
let writeCalls: any[]
let receipt: Promise<{ status: string }>
let cardProps: any
const refetchSpy = vi.fn()
const publicClient = { waitForTransactionReceipt: () => receipt }

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: TRADER }),
  useReadContract: () => ({ data: orderRead.data, isError: !!orderRead.isError, refetch: refetchSpy }),
  useWriteContract: () => ({
    writeContractAsync: async (args: any) => {
      writeCalls.push(args)
      return '0xhash'
    },
  }),
  usePublicClient: () => publicClient,
}))
vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}))
vi.mock('../components/OrderStatusCard', () => ({
  OrderStatusCard: (props: any) => {
    cardProps = props
    return <div data-testid="card">card for order {String(props.orderId)}</div>
  },
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to={`/order/${MARKET}/8`}>go to order 8</Link>
      <Routes>
        <Route path="/order/:address/:orderId" element={<OrderPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  orderRead = { data: { trader: TRADER } }
  writeCalls = []
  receipt = Promise.resolve({ status: 'success' })
  cardProps = undefined
  refetchSpy.mockClear()
})

afterEach(cleanup)

describe('OrderPage: bad links', () => {
  it.each([
    ['an address that is not one', `/order/not-an-address/7`],
    ['a truncated address', `/order/0x1234/7`],
    ['the zero address', `/order/${ZERO}/7`],
    ['an order id that is not a number', `/order/${MARKET}/abc`],
    ['order id 0', `/order/${MARKET}/0`],
    ['a negative order id', `/order/${MARKET}/-3`],
    ['a decimal order id', `/order/${MARKET}/1.5`],
  ])('%s says "Invalid order link", with a way back, and reads nothing', (_name, path) => {
    renderAt(path)

    expect(screen.getByText('Invalid order link')).toBeDefined()
    expect(screen.queryByTestId('card')).toBeNull()
    expect(screen.getByRole('link', { name: /back to markets/i }).getAttribute('href')).toBe('/')
  })

  it('rejects a mixed-case address whose checksum is wrong (a typo)', () => {
    const good = getAddress('0x52908400098527886e0f7030069857d2e4169ee7')
    const i = good.slice(2).search(/[a-fA-F]/) + 2
    const c = good[i]
    const typo = good.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + good.slice(i + 1)

    renderAt(`/order/${typo}/1`)
    expect(screen.getByText('Invalid order link')).toBeDefined()

    cleanup()
    renderAt(`/order/${good}/1`)
    expect(screen.getByTestId('card')).toBeDefined()
  })
})

describe('OrderPage: an order that is not there', () => {
  it('a zeroed struct (an id nobody used) is "Order not found" with a link back, not "Loading order..."', () => {
    orderRead = { data: { trader: ZERO } }
    renderAt(`/order/${MARKET}/7`)

    expect(screen.getByText('Order not found')).toBeDefined()
    expect(screen.getByText('There is no order #7 on this market.')).toBeDefined()
    expect(screen.queryByTestId('card')).toBeNull()
    expect(screen.getByRole('link', { name: /back to markets/i }).getAttribute('href')).toBe('/')
  })

  it('a read that keeps failing is "Order not found" too, and offers a retry', () => {
    orderRead = { data: undefined, isError: true }
    renderAt(`/order/${MARKET}/7`)

    expect(screen.getByText('Order not found')).toBeDefined()
    expect(screen.getByText(/couldn't read this order/i)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refetchSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: /back to markets/i })).toBeDefined()
  })

  it('while the read is still in flight the card (which says "Loading order...") is shown', () => {
    orderRead = { data: undefined, isError: false }
    renderAt(`/order/${MARKET}/7`)
    expect(screen.getByTestId('card')).toBeDefined()
    expect(screen.queryByText('Order not found')).toBeNull()
  })

  it('an error with data in hand does not hide the order', () => {
    orderRead = { data: { trader: TRADER }, isError: true }
    renderAt(`/order/${MARKET}/7`)
    expect(screen.getByTestId('card')).toBeDefined()
  })
})

describe('OrderPage: a real order', () => {
  it('shows the title, the card and the way back to the market', () => {
    renderAt(`/order/${MARKET}/7`)

    expect(screen.getByText('Order #7')).toBeDefined()
    expect(cardProps.orderId).toBe(7n)
    expect(cardProps.marketAddress).toBe(MARKET)
    expect(screen.getByRole('link', { name: /back to market/i }).getAttribute('href')).toBe(`/market/${MARKET}`)
  })

  it.each([
    ['onClaim', 'claim', [7n], []],
    ['onCancel', 'cancelOrder', [7n], []],
    ['onRefund', 'refundExpired', [7n], []],
    // The recovery is aimed at a MATCH, whichever one the card found.
    ['onEmergencyRefund', 'emergencyRefundMatch', [3n], [3n]],
  ])('%s sends %s and follows it to the receipt', async (prop, fn, args, callArgs) => {
    renderAt(`/order/${MARKET}/7`)

    await act(async () => {
      await cardProps[prop](...callArgs)
    })

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0].functionName).toBe(fn)
    expect(writeCalls[0].args).toEqual(args)
    expect(writeCalls[0].address).toBe(MARKET)
    // Confirmed, with the explorer link, and the card was told to refetch.
    expect(screen.getByRole('status').textContent).toMatch(/confirmed/i)
    expect(screen.getByRole('link', { name: /view transaction/i }).getAttribute('href')).toMatch(/\/tx\/0xhash$/)
    expect(cardProps.refreshSignal).toBe(1)
  })

  it('tells the card a transaction is pending until the receipt lands', async () => {
    let mined!: (r: { status: string }) => void
    receipt = new Promise((resolve) => {
      mined = resolve
    })
    renderAt(`/order/${MARKET}/7`)
    expect(cardProps.txPending).toBe(false)

    act(() => {
      void cardProps.onCancel()
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/submitted/i))
    expect(cardProps.txPending).toBe(true)
    expect(cardProps.refreshSignal).toBe(0)

    await act(async () => mined({ status: 'success' }))
    await waitFor(() => expect(cardProps.txPending).toBe(false))
    expect(cardProps.refreshSignal).toBe(1)
  })

  it('shows why a transaction failed, on the page', async () => {
    receipt = Promise.resolve({ status: 'reverted' })
    renderAt(`/order/${MARKET}/7`)

    await act(async () => {
      await cardProps.onClaim()
    })

    expect(screen.getByRole('alert').textContent).toMatch(/Claim failed: .*reverted on chain/)
    expect(cardProps.refreshSignal).toBe(0)
  })

  it('does not carry one order\'s transaction status to the next order', async () => {
    renderAt(`/order/${MARKET}/7`)
    await act(async () => {
      await cardProps.onCancel()
    })
    expect(screen.getByRole('status').textContent).toMatch(/confirmed/i)
    expect(cardProps.refreshSignal).toBe(1)

    // Same route, different order: React Router does not remount the page.
    fireEvent.click(screen.getByRole('link', { name: 'go to order 8' }))

    expect(cardProps.orderId).toBe(8n)
    expect(screen.queryByRole('status')).toBeNull()
    expect(cardProps.refreshSignal).toBe(0)
  })
})
