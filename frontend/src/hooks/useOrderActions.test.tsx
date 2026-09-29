import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { useOrderActions } from './useOrderActions'
import { useClaim } from './useClaim'
import { TxStatus } from '../components/TxStatus'

/**
 * A claim, cancel, refund or recovery is "pending" until the RECEIPT.
 *
 * writeContractAsync resolves when the wallet has broadcast the transaction, not
 * when it has been mined. The old useClaim (and Order.tsx's refund handlers)
 * stopped there: the button came back while the transaction was still in
 * flight, a revert on chain looked like success, and there was no explorer link.
 * These tests drive the state machine with a mocked public client and hold each
 * promise open, so every intermediate state is observable.
 */

const MARKET = '0x00000000000000000000000000000000000000aa' as const
const MARKET_2 = '0x00000000000000000000000000000000000000dd' as const
const TRADER = '0x00000000000000000000000000000000000000bb'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let account: string | undefined
let noPublicClient: boolean
let chainOk: boolean
let writeCalls: any[]
let writeImpl: (args: any) => Promise<string>
let receiptImpl: (args: any) => Promise<any>

const publicClient = { waitForTransactionReceipt: (args: any) => receiptImpl(args) }

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: account }),
  useWriteContract: () => ({
    writeContractAsync: (args: any) => {
      writeCalls.push(args)
      return writeImpl(args)
    },
  }),
  usePublicClient: () => (noPublicClient ? undefined : publicClient),
}))

vi.mock('./useEnsureChain', () => ({
  useEnsureChain: () => async () =>
    chainOk ? { ok: true } : { ok: false, error: 'Switch your wallet to Robinhood Chain Testnet.' },
}))

function Probe({ market, onConfirmed }: { market?: `0x${string}`; onConfirmed?: (c: any) => void }) {
  const a = useOrderActions(market, { onConfirmed })
  return (
    <>
      <button onClick={() => void a.claim(5n)}>claim</button>
      <button onClick={() => void a.cancel(5n)}>cancel</button>
      <button onClick={() => void a.refundExpired(5n)}>refund</button>
      <button onClick={() => void a.recover(9n)}>recover</button>
      <button onClick={() => void a.claim(6n, MARKET_2)}>claim-other</button>
      <button onClick={() => a.reset()}>reset</button>
      <div data-testid="phase">{a.state.phase}</div>
      <div data-testid="pending">{String(a.isPending)}</div>
      <div data-testid="hash">{a.state.hash ?? ''}</div>
      <div data-testid="error">{a.state.error ?? ''}</div>
      <div data-testid="target">{`${a.state.market ?? ''}:${a.state.id ?? ''}`}</div>
      <TxStatus state={a.state} />
    </>
  )
}

const text = (id: string) => screen.getByTestId(id).textContent
const click = (name: string) => fireEvent.click(screen.getByText(name))

beforeEach(() => {
  account = TRADER
  noPublicClient = false
  chainOk = true
  writeCalls = []
  writeImpl = async () => '0xhash'
  receiptImpl = async () => ({ status: 'success' })
})

afterEach(cleanup)

describe('useOrderActions: from the click to the receipt', () => {
  it('stays pending until the receipt, then confirms and reports what changed', async () => {
    const write = deferred<string>()
    const receipt = deferred<{ status: string }>()
    writeImpl = () => write.promise
    receiptImpl = () => receipt.promise
    const onConfirmed = vi.fn()

    render(<Probe market={MARKET} onConfirmed={onConfirmed} />)
    expect(text('phase')).toBe('idle')
    expect(text('pending')).toBe('false')

    click('claim')
    await waitFor(() => expect(text('phase')).toBe('awaiting-signature'))
    expect(text('pending')).toBe('true')
    expect(screen.getByRole('status').textContent).toMatch(/confirm the claim in your wallet/i)

    // The wallet broadcasts. The old hook stopped being "pending" HERE.
    await act(async () => write.resolve('0xabc'))
    await waitFor(() => expect(text('phase')).toBe('submitted'))
    expect(text('hash')).toBe('0xabc')
    expect(text('pending')).toBe('true')
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /view transaction/i }).getAttribute('href')).toMatch(/\/tx\/0xabc$/)

    // The block lands.
    await act(async () => receipt.resolve({ status: 'success' }))
    await waitFor(() => expect(text('phase')).toBe('confirmed'))
    expect(text('pending')).toBe('false')
    expect(screen.getByRole('status').textContent).toMatch(/claim confirmed/i)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledWith({ action: 'claim', hash: '0xabc', market: MARKET, id: 5n })
  })

  it('a transaction that is mined but reverted is a failure, with the hash to look at', async () => {
    receiptImpl = async () => ({ status: 'reverted' })
    const onConfirmed = vi.fn()

    render(<Probe market={MARKET} onConfirmed={onConfirmed} />)
    click('cancel')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toMatch(/mined but reverted on chain/i)
    expect(text('hash')).toBe('0xhash')
    expect(text('pending')).toBe('false')
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/Cancel failed/)
    expect(screen.getByRole('link', { name: /view transaction/i })).toBeDefined()
  })

  it('a receipt that cannot be fetched says the transaction may still go through', async () => {
    receiptImpl = async () => {
      throw new Error('timed out')
    }

    render(<Probe market={MARKET} />)
    click('claim')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toMatch(/may still go through/i)
    expect(text('hash')).toBe('0xhash')
  })

  it('with no client to follow the transaction it is reported, not left submitted for ever', async () => {
    noPublicClient = true

    render(<Probe market={MARKET} />)
    click('claim')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toMatch(/may still go through/i)
    expect(text('hash')).toBe('0xhash')
    expect(text('pending')).toBe('false')
  })

  it('a refusal in the wallet reads as nothing sent', async () => {
    writeImpl = async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }

    render(<Probe market={MARKET} />)
    click('claim')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toBe('Cancelled in your wallet - nothing was sent.')
    expect(text('hash')).toBe('')
  })

  it('a contract revert is translated (the error the portfolio used to drop)', async () => {
    writeImpl = async () => {
      throw { shortMessage: 'The contract function "cancelOrder" reverted with the following reason:\nalready refunded' }
    }

    render(<Probe market={MARKET} />)
    click('cancel')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toMatch(/already returned/i)
  })

  it('does not send anything when the wallet is on the wrong network and says why', async () => {
    chainOk = false

    render(<Probe market={MARKET} />)
    click('claim')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toMatch(/Switch your wallet/)
    expect(writeCalls).toHaveLength(0)
  })

  it('does not send anything without a connected wallet', async () => {
    account = undefined

    render(<Probe market={MARKET} />)
    click('claim')

    await waitFor(() => expect(text('phase')).toBe('failed'))
    expect(text('error')).toBe('Connect your wallet first.')
    expect(writeCalls).toHaveLength(0)
  })

  it('ignores a second click while one transaction is in flight', async () => {
    const write = deferred<string>()
    writeImpl = () => write.promise

    render(<Probe market={MARKET} />)
    click('claim')
    await waitFor(() => expect(text('phase')).toBe('awaiting-signature'))
    click('claim')
    click('cancel')

    expect(writeCalls).toHaveLength(1)

    await act(async () => write.resolve('0xabc'))
    await waitFor(() => expect(text('phase')).toBe('confirmed'))
  })

  it('can be tried again after a failure', async () => {
    writeImpl = async () => {
      throw new Error('boom')
    }
    render(<Probe market={MARKET} />)
    click('claim')
    await waitFor(() => expect(text('phase')).toBe('failed'))

    writeImpl = async () => '0xsecond'
    click('claim')
    await waitFor(() => expect(text('phase')).toBe('confirmed'))
    expect(text('hash')).toBe('0xsecond')
    expect(text('error')).toBe('')
  })

  it('reset returns to idle', async () => {
    render(<Probe market={MARKET} />)
    click('claim')
    await waitFor(() => expect(text('phase')).toBe('confirmed'))
    click('reset')
    expect(text('phase')).toBe('idle')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('useOrderActions: which call is made', () => {
  const lastWrite = () => writeCalls[writeCalls.length - 1]

  it.each([
    ['claim', 'claim', 5n],
    ['cancel', 'cancelOrder', 5n],
    ['refund', 'refundExpired', 5n],
    // emergencyRefundMatch takes a MATCH id, not an order id.
    ['recover', 'emergencyRefundMatch', 9n],
  ])('the %s button calls %s with %s', async (button, fn, id) => {
    render(<Probe market={MARKET} />)
    click(button)
    await waitFor(() => expect(text('phase')).toBe('confirmed'))

    expect(lastWrite().functionName).toBe(fn)
    expect(lastWrite().args).toEqual([id])
    expect(lastWrite().address).toBe(MARKET)
  })

  it('takes the market per call for a list that spans markets, and says which row it was about', async () => {
    render(<Probe market={undefined} />)
    click('claim-other')
    await waitFor(() => expect(text('phase')).toBe('confirmed'))

    expect(lastWrite().address).toBe(MARKET_2)
    expect(text('target')).toBe(`${MARKET_2}:6`)
  })

  it('does nothing when there is no market to call at all', async () => {
    render(<Probe market={undefined} />)
    click('claim')
    await act(async () => {})

    expect(writeCalls).toHaveLength(0)
    expect(text('phase')).toBe('idle')
  })
})

function ClaimProbe() {
  const c = useClaim(MARKET)
  return (
    <>
      <button onClick={() => void c.claim(5n)}>claim</button>
      <div data-testid="pending">{String(c.pending)}</div>
      <div data-testid="tx">{c.tx ?? ''}</div>
      <div data-testid="error">{c.error ?? ''}</div>
    </>
  )
}

describe('useClaim', () => {
  it('is pending until the receipt, and exposes the hash', async () => {
    const receipt = deferred<{ status: string }>()
    receiptImpl = () => receipt.promise

    render(<ClaimProbe />)
    click('claim')
    await waitFor(() => expect(text('tx')).toBe('0xhash'))
    expect(text('pending')).toBe('true')

    await act(async () => receipt.resolve({ status: 'success' }))
    await waitFor(() => expect(text('pending')).toBe('false'))
    expect(text('error')).toBe('')
  })

  it('carries the reason for a failure instead of dropping it', async () => {
    receiptImpl = async () => ({ status: 'reverted' })

    render(<ClaimProbe />)
    click('claim')

    await waitFor(() => expect(text('error')).toMatch(/reverted on chain/i))
    expect(text('pending')).toBe('false')
  })
})
