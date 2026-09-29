import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics } from 'viem'
import { usePlaceBet } from './usePlaceBet'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { TARGET_CHAIN_ID } from '../lib/chain'

/**
 * The approval has to be mined before the bet is sent.
 *
 * `writeContractAsync` resolves as soon as the wallet submits, not when the
 * transaction lands. The bet went out immediately after, so the wallet
 * estimated gas for a placeBet whose allowance did not exist yet - which reads
 * to the user as "transfer amount exceeds allowance" on a bet they were told
 * had been approved. Nonce ordering means it would eventually have executed in
 * the right order; the estimation happens first and does not care.
 *
 * The receipt wait existed in this file already, as a
 * useWaitForTransactionReceipt nobody awaited.
 */

const MARKET = '0x00000000000000000000000000000000000000aa' as const
const MARKET_2 = '0x00000000000000000000000000000000000000cc' as const
const ACCOUNT = '0x00000000000000000000000000000000000000bb' as const
const ACCOUNT_2 = '0x00000000000000000000000000000000000000dd' as const
const calls: string[] = []

let approvalMined!: () => void
let approveCallArgs: any
/** What sendTransactionAsync was asked to send: the bet itself on the Base path. */
let betCallArgs: any
/** The connected wallet. Tests change it to simulate an account switch mid-flight. */
let mockAccount: string = ACCOUNT
/** Logs carried by the bet's receipt, for the OrderPlaced decode. */
let mockBetLogs: any[] = []
/** What useSendTransaction reports as its last hash: the PREVIOUS send's, on a retry. */
let mockSendData: string | undefined

/**
 * Controls what useWaitForTransactionReceipt reports for the BET transaction
 * once it has a hash to watch. 'pending' mirrors the old static mock (no
 * receipt yet); tests that care about the outcome switch this before
 * rendering.
 */
let mockBetReceipt: 'pending' | 'success' | 'reverted' = 'pending'

/**
 * What PoolMarketFactory.isMarket reports for the probed address, and what a
 * refetch of it resolves to. True by default: every test in this file except
 * the "audit A05" block below is about something else entirely (approval
 * ordering, receipt tracking, stale state) and assumes a legitimately
 * verified market, matching what Market.tsx's own gate would have already
 * confirmed before this hook's execute() ever runs on a real page.
 */
let mockIsMarket: boolean | undefined = true
let mockIsMarketRefetchResult: boolean | undefined = true

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mockAccount }),
  usePublicClient: () => ({
    waitForTransactionReceipt: async () => {
      calls.push('approval-receipt')
      // Held open until the test releases it, so "the bet went out early" is
      // observable rather than a race the test might win by accident.
      await new Promise<void>((resolve) => { approvalMined = resolve })
      return { status: 'success' }
    },
    // The market check when the hook's own isMarket read has not resolved: a
    // direct read of the chain for the frozen market, not a refetch of the
    // hook query (which would answer for whatever market is picked by then).
    readContract: async ({ functionName }: any) => {
      if (functionName === 'isMarket') return mockIsMarketRefetchResult
      return undefined
    },
  }),
  useReadContract: ({ functionName }: any) => {
    if (functionName === 'feedId') return { data: '0x5045504500000000000000000000000000000000000000000000000000000000' }
    if (functionName === 'allowance') return { data: 0n, refetch: async () => {} } // forces an approve
    if (functionName === 'isMarket') return { data: mockIsMarket, refetch: async () => ({ data: mockIsMarketRefetchResult }) }
    return { data: undefined, refetch: async () => {} }
  },
  useWriteContract: () => ({
    writeContractAsync: async (args: any) => {
      calls.push('approve')
      approveCallArgs = args
      return '0xapprovehash'
    },
    data: undefined,
  }),
  useSendTransaction: () => ({
    sendTransactionAsync: async (args: any) => { calls.push('bet'); betCallArgs = args; return '0xbethash' },
    data: mockSendData,
  }),
  useWaitForTransactionReceipt: ({ hash, query }: any) => {
    if (!hash || query?.enabled === false || mockBetReceipt === 'pending') {
      return { data: undefined, isSuccess: false, isError: false, error: undefined }
    }
    return {
      data: { status: mockBetReceipt, transactionHash: hash, logs: mockBetLogs },
      isSuccess: true,
      isError: false,
      error: undefined,
    }
  },
}))

vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('./useEnsureChain',        () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../lib/oracle', () => ({
  fetchBetPayload: async () => '0xdeadbeef',
  withPayload: (d: string, p: string) => d + p.slice(2),
}))
vi.mock('../lib/referral', () => ({ getPendingReferrer: () => '0x0000000000000000000000000000000000000000' }))

function Probe({ amountUsd = '10', expectedPrice = 1_000_000_000_000_000_000n }: { amountUsd?: string; expectedPrice?: bigint } = {}) {
  const [market, setMarket] = useState<string>(MARKET)
  const [direction, setDirection] = useState<0 | 1>(0)
  const [amount, setAmount] = useState<string>(amountUsd)
  const bet = usePlaceBet({
    marketAddress: market as `0x${string}`,
    direction,
    amountUsd: amount,
    expectedPrice,
    slippageBps: 100,
  })
  return (
    <>
      <button onClick={() => { void bet.execute() }}>go</button>
      <button onClick={() => setMarket(MARKET_2)}>switch market</button>
      <button onClick={() => setDirection(1)}>switch direction</button>
      <button onClick={() => setAmount('20')}>change stake</button>
      <div data-testid="step">{bet.step}</div>
      <div data-testid="error">{bet.error ?? ''}</div>
      <div data-testid="busy">{String(bet.busy)}</div>
      <div data-testid="order">{bet.orderId === undefined ? '' : bet.orderId.toString()}</div>
      <div data-testid="intent-market">{bet.intent?.marketAddress ?? ''}</div>
    </>
  )
}

beforeEach(() => {
  calls.length = 0
  approveCallArgs = undefined
  betCallArgs = undefined
  mockAccount = ACCOUNT
  mockBetLogs = []
  mockSendData = undefined
  mockBetReceipt = 'pending'
  mockIsMarket = true
  mockIsMarketRefetchResult = true
})
afterEach(cleanup)

describe('usePlaceBet, approval ordering', () => {
  it('does not send the bet until the approval has been mined', async () => {
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))

    // The approval is submitted and being waited on. Nothing may have been bet.
    expect(calls).toEqual(['approve', 'approval-receipt'])

    approvalMined()

    await waitFor(() => expect(calls).toEqual(['approve', 'approval-receipt', 'bet']))
  })
})

describe('usePlaceBet, bounded approval', () => {
  /**
   * A link to /market/0xAttacker on the real domain used to get a connected
   * user to approve their ENTIRE balance (maxUint256) to whatever contract
   * the URL named, before anything had checked the address was a real
   * market. Market.tsx now refuses to render the Composer for an address
   * that fails PoolMarketFactory.isMarket - but this hook is the last line
   * of defence, so it must never ask for more allowance than the bet it is
   * actually about to place needs.
   */
  it('approves only the stake amount, never an unlimited allowance', async () => {
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(approveCallArgs).toBeDefined())

    // Probe bets amountUsd: '10' at the default (6-decimal) test currency.
    expect(approveCallArgs.args[1]).toBe(10_000_000n)
    expect(approveCallArgs.args[1]).not.toBe(2n ** 256n - 1n) // maxUint256
  })
})

describe('usePlaceBet, audit A05 (2026-09-28): re-verifies isMarket before any approval or signature', () => {
  /**
   * Market.tsx's own gate has its own bug fixed separately (notAMarket =
   * isRealMarket === false treated an RPC error identically to "confirmed
   * fine"), but that only protects one page - Markets.tsx mounts this same
   * hook with no isMarket check of its own at all. This is the one place
   * every bet actually goes through, so it has to refuse on its own,
   * regardless of what the calling page already checked or forgot to.
   */
  it('refuses when isMarket is confirmed false, without approving or betting', async () => {
    mockIsMarket = false
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))
    expect(screen.getByTestId('error').textContent).toContain('Could not verify')
    expect(calls).toEqual([])
  })

  it('refuses when isMarket has not resolved and a fresh refetch also comes back empty', async () => {
    mockIsMarket = undefined
    mockIsMarketRefetchResult = undefined
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))
    expect(calls).toEqual([])
  })

  it('proceeds once a refetch confirms isMarket true, even if the initial read had not resolved yet', async () => {
    mockIsMarket = undefined
    mockIsMarketRefetchResult = true
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approve'))
  })
})

describe('usePlaceBet, step tracks the actual receipt', () => {
  /**
   * Before this, `step` was set to 'betting' at submission and nothing ever
   * moved it off that based on what actually happened on chain - only
   * `isConfirmed` was derived from the receipt, and the Composer button reads
   * `step`, not `isConfirmed`. A reverted or dropped bet left the CTA reading
   * "PLACING BET..." forever, with no way to retell it apart from a slow
   * confirmation, and no way to retry.
   */
  it('moves to error, not stuck on betting, when the bet reverts on-chain', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))
    expect(screen.getByTestId('error').textContent?.toLowerCase()).toContain('revert')
  })

  it('moves to confirmed once the receipt reports success', async () => {
    mockBetReceipt = 'success'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('confirmed'))
  })
})

describe('usePlaceBet, stale status does not follow a new pick', () => {
  /**
   * marketAddress/direction come through as plain props, not a remount, so
   * nothing used to clear a previous bet's error/orderId/step when the user
   * picked a different market or flipped direction - an old "RETRY" banner
   * (or a stale orderId) could bleed into an unrelated new bet.
   */
  it('clears a stale error when the user switches to a different market', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))

    screen.getByRole('button', { name: 'switch market' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('idle'))
    expect(screen.getByTestId('error').textContent).toBe('')
  })

  it('clears a stale error when the user switches direction on the same market', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))

    screen.getByRole('button', { name: 'switch direction' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('idle'))
    expect(screen.getByTestId('error').textContent).toBe('')
  })
})

describe('usePlaceBet, malformed stake does not crash the render', () => {
  /**
   * `Number(x).toString()` for a very small value (e.g. typing 0.0000001)
   * produces exponential notation ("1e-7"), and viem's parseUnits throws on
   * that rather than returning 0. The hook computed amountWei unconditionally
   * in its body - not inside execute()'s try/catch - so this threw during
   * render itself, on every render, with no error boundary anywhere in the
   * app to catch it: a white screen from typing one too many zeros.
   */
  it('does not throw when amountUsd is exponential notation', () => {
    expect(() => render(<Probe amountUsd="1e-7" />)).not.toThrow()
  })

  it('does not throw for other malformed amounts (empty, partial, garbage)', () => {
    for (const bad of ['', '.', '-', 'abc', '1.2.3']) {
      expect(() => render(<Probe amountUsd={bad} />)).not.toThrow()
      cleanup()
    }
  })
})

/**
 * Audit U01 (2026-09-28): a bet is the intent frozen when execute() starts.
 *
 * The approval and the bet are separated by wallet prompts that can stay open
 * as long as the user likes, and the hook's props are live. Pressing DOWN while
 * the UP approval was open reset the hook's step (the effect above) but left
 * the old execute() running; a second BUY then started a second bet; the
 * OrderPlaced log was matched against whichever market was picked by the time
 * the receipt came back; and the Composer redirected to that market too.
 */

function orderPlacedLog(market: string, orderId: bigint, dir = 0, amount = 10_000_000n) {
  return {
    address: market,
    topics: encodeEventTopics({ abi: ORDERBOOK_MARKET_ABI, eventName: 'OrderPlaced', args: { orderId, trader: ACCOUNT } }),
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [dir, amount]),
  }
}

const click = async (name: string) => {
  await act(async () => {
    screen.getByRole('button', { name }).click()
  })
}
const text = (id: string) => screen.getByTestId(id).textContent

describe('usePlaceBet, one bet at a time (audit U01)', () => {
  it('ignores a second execute() while the approval is being confirmed', async () => {
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))

    await click('go')
    await click('go')

    // One approval, and nothing else started behind it.
    expect(calls).toEqual(['approve', 'approval-receipt'])

    approvalMined()
    await waitFor(() => expect(calls).toEqual(['approve', 'approval-receipt', 'bet']))
  })

  it('ignores a second execute() fired in the same tick as the first', async () => {
    render(<Probe />)
    await act(async () => {
      const go = screen.getByRole('button', { name: 'go' })
      go.click()
      go.click()
      go.click()
    })
    await waitFor(() => expect(calls).toContain('approval-receipt'))
    expect(calls.filter((c) => c === 'approve')).toHaveLength(1)
  })

  it('ignores execute() while the bet is submitted and waiting for its receipt', async () => {
    render(<Probe />) // receipt stays pending
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))
    await waitFor(() => expect(text('step')).toBe('betting'))

    await click('go')

    expect(calls.filter((c) => c === 'bet')).toHaveLength(1)
    expect(calls.filter((c) => c === 'approve')).toHaveLength(1)
  })

  it('accepts a new bet once the last one has failed', async () => {
    mockIsMarket = false
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(text('step')).toBe('error'))

    // Re-render so the hook sees the market as verified, then try again.
    mockIsMarket = true
    await click('change stake')
    await click('go')
    await waitFor(() => expect(calls).toContain('approve'))
  })

  it('reports busy from the click until the bet has a verdict', async () => {
    mockBetReceipt = 'success'
    render(<Probe />)
    expect(text('busy')).toBe('false')

    await click('go')
    expect(text('busy')).toBe('true')

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    expect(text('busy')).toBe('true')

    approvalMined()
    await waitFor(() => expect(text('step')).toBe('confirmed'))
    expect(text('busy')).toBe('false')
  })

  it('is busy through the wait for the receipt, not only through the approval', async () => {
    render(<Probe />) // receipt stays pending
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(text('step')).toBe('betting'))
    expect(text('busy')).toBe('true')
  })

  it('is not busy after a failure', async () => {
    mockIsMarket = false
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(text('step')).toBe('error'))
    expect(text('busy')).toBe('false')
  })
})

describe('usePlaceBet, the bet is what was on screen at the click (audit U01)', () => {
  it('approves and sends the original market, side and stake after all three are changed mid-approval', async () => {
    render(<Probe />) // MARKET, UP, 10
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))

    await click('switch market')
    await click('switch direction')
    await click('change stake')

    // The approval that is already open was for the original bet...
    expect(approveCallArgs.args).toEqual([MARKET, 10_000_000n])
    // ...and changing the pick did not reset the step underneath it, which is
    // what used to unlock the button while the old bet carried on.
    expect(text('step')).toBe('approving')
    expect(text('busy')).toBe('true')

    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))

    // The bet follows the approval, to the same market, on the same side, for
    // the same stake. The Probe's fake withPayload appends 4 bytes.
    expect(betCallArgs.to).toBe(MARKET)
    const decoded = decodeFunctionData({ abi: ORDERBOOK_MARKET_ABI, data: betCallArgs.data.slice(0, -8) })
    expect(decoded.functionName).toBe('placeBet')
    expect(decoded.args?.[0]).toBe(0) // UP, not the DOWN that was clicked meanwhile
    expect(decoded.args?.[1]).toBe(10_000_000n) // 10, not the 20 typed meanwhile
    expect(decoded.args?.[3]).toBe(1_000_000_000_000_000_000n)
    expect(decoded.args?.[4]).toBe(100n)
  })

  it('signs as the account, and for the chain, it started with', async () => {
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))

    // The wallet's account changes while the approval prompt is open; the next
    // render (any prop change will do) sees the new one.
    mockAccount = ACCOUNT_2
    await click('switch market')

    expect(approveCallArgs.account).toBe(ACCOUNT)
    expect(approveCallArgs.chainId).toBe(TARGET_CHAIN_ID)

    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))
    expect(betCallArgs.account).toBe(ACCOUNT)
    expect(betCallArgs.chainId).toBe(TARGET_CHAIN_ID)
  })

  it('exposes the frozen intent, and keeps it when the props move on', async () => {
    render(<Probe />)
    expect(text('intent-market')).toBe('')

    await click('go')
    expect(text('intent-market')).toBe(MARKET)

    await click('switch market')
    expect(text('intent-market')).toBe(MARKET)
  })

  it('reads OrderPlaced from the market the bet was sent to, not the one picked by then', async () => {
    mockBetReceipt = 'success'
    // A log from the market that is picked by the time the receipt arrives,
    // listed first: the old decode looked at the current market and took it.
    mockBetLogs = [orderPlacedLog(MARKET_2, 99n), orderPlacedLog(MARKET, 7n)]
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))

    await click('switch market')
    approvalMined()

    await waitFor(() => expect(text('step')).toBe('confirmed'))
    await waitFor(() => expect(text('order')).toBe('7'))
    expect(text('intent-market')).toBe(MARKET)
  })

  it('still clears a finished bet\'s status when the props change afterwards', async () => {
    mockIsMarket = false
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(text('step')).toBe('error'))
    expect(text('intent-market')).toBe(MARKET)

    await click('switch market')

    await waitFor(() => expect(text('step')).toBe('idle'))
    expect(text('intent-market')).toBe('')
  })
})

describe('usePlaceBet, a retry does not inherit the previous send (audit U01)', () => {
  it('is not flipped to "error" by the previous send receipt while its own approval is open', async () => {
    // The wallet library still reports the previous, reverted bet's hash.
    mockSendData = '0xoldhash'
    mockBetReceipt = 'reverted'
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(calls).toContain('approval-receipt'))

    expect(text('step')).toBe('approving')
    expect(text('error')).toBe('')
    expect(text('busy')).toBe('true')
  })
})

describe('usePlaceBet, refuses to start a bet it cannot price (audit U02)', () => {
  it('does not approve anything when the price is zero', async () => {
    render(<Probe expectedPrice={0n} />)
    await click('go')

    await waitFor(() => expect(text('step')).toBe('error'))
    expect(text('error')).toContain('Price unavailable')
    expect(calls).toEqual([]) // no approval was requested for a bet that would revert
    expect(text('busy')).toBe('false')
  })
})

describe('usePlaceBet, the market check is about the frozen market (audit A05 + U01)', () => {
  it('asks the chain about the market the bet is for when the hook read has not resolved', async () => {
    mockIsMarket = undefined
    mockIsMarketRefetchResult = true
    render(<Probe />)
    await click('go')
    await waitFor(() => expect(calls).toContain('approve'))
    expect(approveCallArgs.args[0]).toBe(MARKET)
  })
})
