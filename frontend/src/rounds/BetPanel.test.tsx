import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BetPanel, type BetPanelProps } from './BetPanel'
import { makeRound, milli, T_CONSTANTS, T_INDEX, T_PLAYER, T_POOL, T_ROUND_ID, T_TIMES } from './testFixtures'
import { clockTime } from './roundMath'

const bet = vi.fn()
let connected = true
let wethBalance = 10n ** 18n

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: connected ? T_PLAYER : undefined, isConnected: connected }),
  useBalance: () => ({ data: { value: 10n ** 18n } }),
  useReadContract: () => ({ data: wethBalance }),
}))
vi.mock('../hooks/useConnectWallet', () => ({ useConnectWallet: () => ({ connectWallet: vi.fn() }) }))
vi.mock('./useRoundTx', () => ({
  MIN_SECONDS_TO_BET: 8,
  useRoundTx: () => ({ state: { step: 'idle' }, busy: false, bet, claim: vi.fn(), wrap: vi.fn() }),
}))

function renderPanel(over: Partial<BetPanelProps> = {}) {
  const props: BetPanelProps = {
    pool: { pool: T_POOL, symbol: 'PEPE' },
    duration: 300,
    roundId: T_ROUND_ID,
    index: T_INDEX,
    times: T_TIMES,
    round: makeRound({ up: milli(20), down: milli(10) }),
    now: T_TIMES.openAt + 60,
    constants: T_CONSTANTS,
    alreadyIn: false,
    ...over,
  }
  return render(
    <MemoryRouter>
      <BetPanel {...props} />
    </MemoryRouter>,
  )
}

const cta = () => screen.getAllByRole('button').find((b) => b.classList.contains('cta')) as HTMLButtonElement

beforeEach(() => {
  bet.mockReset()
  connected = true
  wethBalance = 10n ** 18n
})
afterEach(cleanup)

describe('before the signature the player sees what the bet is on', () => {
  it('a timeline with clock times: bets, pause, strike, exit, result', () => {
    renderPanel()
    const tl = screen.getByLabelText('Round timeline')
    expect(tl.textContent).toContain(`Bets open${clockTime(T_TIMES.openAt)}-${clockTime(T_TIMES.closeAt)} · 5 minutes`)
    expect(tl.textContent).toContain(`Pause${clockTime(T_TIMES.closeAt)}-${clockTime(T_TIMES.strikeStart)}`)
    expect(tl.textContent).toContain(`Strike averaged${clockTime(T_TIMES.strikeStart)}-${clockTime(T_TIMES.strikeEnd)}`)
    expect(tl.textContent).toContain(`Resultfrom ${clockTime(T_TIMES.settleAt)}`)
    expect(tl.textContent).toMatch(/The price during bets and the pause does not count/)
    expect(tl.textContent).toMatch(/Result about 15 minutes after bets close, 20 after this round opened/)
  })

  it('a plain statement next to the button that it is not a bet on the price now', () => {
    renderPanel()
    const note = screen.getByRole('note')
    expect(note.textContent).toMatch(
      /^You bet on the move from the strike to the exit, not on the price now\. The strike is the average price over 5 minutes that start 5 minutes after bets close/,
    )
  })

  it('both sums, in the open', () => {
    renderPanel()
    const sums = screen.getByLabelText('Staked so far').textContent
    expect(sums).toContain('UP so far0.02 WETH')
    expect(sums).toContain('DOWN so far0.01 WETH')
  })

  it('the rules: 1:1 matching, 1.96x, fees, minimum bank, unaudited', () => {
    renderPanel()
    const text = [...document.querySelectorAll('.rules-list li')].map((li) => li.textContent).join('\n')
    expect(text).toContain('Sides are matched 1:1')
    expect(text).toContain('1.96x of the part that plays')
    expect(text).toContain('2% of the matched bank')
    expect(text).toContain('at least 0.02 WETH')
    expect(text).toMatch(/has not been audited/)
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms')
  })
})

describe('the estimate of the part that plays', () => {
  it('says how much of the stake would play at the current sums, and that it changes until the close', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    // UP 0.02 + 0.01 = 0.03 against DOWN 0.01: a third of the UP side plays.
    const est = screen.getByRole('status')
    expect(est.textContent).toMatch(/about 0\.00333\d* WETH of your 0\.01 WETH would play \(33%\)/)
    expect(est.textContent).toMatch(/0\.00666\d* WETH would come back without a fee/)
    expect(est.textContent).toContain(`These numbers change with every bet until ${clockTime(T_TIMES.closeAt)}`)
  })

  it('on the thin side the whole stake plays', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'DOWN' }))
    expect(screen.getByRole('status').textContent).toMatch(/about 0\.01 WETH of your 0\.01 WETH would play \(100%\)\. If your side wins you would collect about 0\.0196 WETH/)
  })

  it('says plainly when nobody is on the other side yet', () => {
    renderPanel({ round: makeRound({ up: milli(20), down: 0n }) })
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    expect(screen.getByRole('status').textContent).toMatch(/Nobody is on DOWN yet, so at the current sums none of your stake would play/)
  })

  it('warns when the matched bank would stay under the minimum', () => {
    renderPanel({ round: makeRound({ up: 0n, down: milli(5) }) })
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('button', { name: '0.005' }))
    expect(screen.getByRole('status').textContent).toMatch(/below the minimum of 0\.02 WETH: unless more is bet, the round does not play/)
  })
})

describe('the bet button', () => {
  it('stays off until a side is picked and the timing is confirmed, then bets exactly that', () => {
    renderPanel()
    expect(cta().textContent).toBe('PICK UP OR DOWN')
    fireEvent.click(screen.getByRole('button', { name: 'DOWN' }))
    expect(cta().disabled).toBe(true)
    expect(cta().textContent).toBe('CONFIRM WHAT YOU BET ON FIRST')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(cta().disabled).toBe(false)
    expect(cta().textContent).toBe('BET 0.01 WETH DOWN')
    fireEvent.click(cta())
    expect(bet).toHaveBeenCalledTimes(1)
    expect(bet.mock.calls[0][0]).toMatchObject({ roundId: T_ROUND_ID, side: 2, stake: milli(10), closeAt: T_TIMES.closeAt })
  })

  it('refuses a stake outside the contract limits', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('WETH'), { target: { value: '0.05' } })
    expect(cta().textContent).toBe('STAKE 0.005-0.04 WETH')
  })

  it('signs nothing when the contract reports a side cap other than 1:1', () => {
    renderPanel({ constants: { ...T_CONSTANTS, chainSideRatio: 4 } })
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(cta().textContent).toBe('RULES OUT OF DATE - SIGNING OFF')
    expect(screen.getByRole('alert').textContent).toMatch(/caps sides at 4:1/)
  })

  it('refuses a second bet in the same round, and a round about to close', () => {
    const a = renderPanel({ alreadyIn: true })
    expect(cta().textContent).toBe('YOU HAVE A BET IN THIS ROUND')
    a.unmount()
    renderPanel({ now: T_TIMES.closeAt - 3 })
    expect(cta().textContent).toMatch(/BETS CLOSING/)
  })

  it('asks to wrap when the wallet holds too little WETH', () => {
    wethBalance = 0n
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(cta().textContent).toBe('NOT ENOUGH WETH - WRAP FIRST')
    expect(screen.getByRole('button', { name: 'WRAP 0.01 ETH' })).toBeTruthy()
  })
})

describe('the pool depth limits the round (maxBankOf, BankTooLargeForPool, PoolTooThin)', () => {
  // UP 0.02, DOWN 0.01 in the fixture round: matched bank 0.02.
  it('shows the depth and the largest bank the round can take now', () => {
    renderPanel({ depth: { depth: 100n * 10n ** 18n, maxBank: milli(40) } })
    expect(screen.getByLabelText('Pool depth').textContent).toMatch(
      /Pool depth now 100 WETH: this round can take a matched bank of up to 0\.04 WETH \(depth \/ 2500\)\. Matched so far 0\.02 WETH\./,
    )
  })

  it('blocks a stake that would push the bank past it, says why, and names the largest stake that fits', () => {
    renderPanel({ depth: { depth: 75n * 10n ** 18n, maxBank: milli(30) } })
    fireEvent.click(screen.getByRole('button', { name: 'DOWN' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '0.02' }))
    expect(cta().disabled).toBe(true)
    expect(cta().textContent).toBe('POOL DEPTH LIMITS THIS ROUND - LOWER THE STAKE')
    const why = screen.getAllByRole('alert').map((a) => a.textContent).join(' ')
    expect(why).toMatch(/The pool's depth limits this round's bank: with this stake the matched bank would be 0\.04 WETH, above the 0\.03 WETH the pool backs now\./)
    expect(why).toMatch(/The largest stake on DOWN that fits now is 0\.005 WETH\./)
    fireEvent.click(screen.getByRole('button', { name: '0.005' }))
    expect(cta().disabled).toBe(false)
  })

  it('never limits the bigger side', () => {
    renderPanel({ depth: { depth: 75n * 10n ** 18n, maxBank: milli(30) } })
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '0.04' }))
    expect(cta().disabled).toBe(false)
  })

  it('takes no bets while the pool is below the depth gate, and says collecting still works', () => {
    renderPanel({ depth: { depth: 40n * 10n ** 18n, maxBank: milli(16) } })
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(cta().textContent).toBe('POOL TOO THIN FOR NEW BETS')
    expect(screen.getByLabelText('Pool depth').textContent).toMatch(/below the 50 WETH a pool needs to take bets\. No new bets until it is deeper; bets already placed can still be collected\./)
  })

  it('states the depth rule before the signature', () => {
    renderPanel()
    const text = [...document.querySelectorAll('.rules-list li')].map((li) => li.textContent).join('\n')
    expect(text).toContain("The pool's depth limits the round.")
    expect(text).toContain('a pool needs 50 WETH of depth to take bets at all')
  })
})

describe('the old design is gone from the form', () => {
  it('never mentions a reveal, a secret or a forfeit', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    expect(document.body.textContent).not.toMatch(/reveal|secret|forfeit/i)
  })
})
