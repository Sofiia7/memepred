import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TicketRow, type TicketRowProps } from './TicketRow'
import { makeBet, milli, T_TIMES } from './testFixtures'
import { OUTCOME_DOWN, OUTCOME_REFUND, OUTCOME_UP, REASON_GRACE, REASON_THIN, TICKET_CLAIMED } from './roundsClient'
import { SIDE_DOWN } from './roundMath'

afterEach(cleanup)

function renderRow(over: Partial<TicketRowProps> = {}) {
  const props: TicketRowProps = {
    bet: makeBet(),
    now: T_TIMES.openAt + 10,
    symbol: 'PEPE',
    tx: { step: 'idle' },
    busy: false,
    onClaim: vi.fn(),
    ...over,
  }
  return { ...render(<TicketRow {...props} />), props }
}

describe('while bets are open', () => {
  it('shows both sums, the part that plays at them, that it can change, and a countdown to the close', () => {
    renderRow({ now: T_TIMES.closeAt - 65 })
    const body = document.querySelector('.rnd-ticket-body')?.textContent ?? ''
    expect(body).toContain('in 01:05')
    expect(body).toContain('Now UP 0.03 WETH, DOWN 0.02 WETH')
    expect(body).toMatch(/0\.013333\d* WETH of your stake plays \(66%\), 0\.00666\d* WETH comes back without a fee/)
    expect(body).toMatch(/This changes until the close/)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('a round that plays: countdowns to the strike and to the settlement', () => {
  const on = { bookFinal: true, activated: true }

  it('pause: counts down to the strike, says nothing is priced yet', () => {
    renderRow({ bet: makeBet({}, on), now: T_TIMES.closeAt + 60 })
    expect(screen.getByText(/nothing is priced yet/).textContent).toContain('(in 04:00)')
  })

  it('strike: counts down to the end of the averaging', () => {
    renderRow({ bet: makeBet({}, on), now: T_TIMES.strikeStart + 100 })
    expect(screen.getByText(/The strike price is being averaged/).textContent).toContain('03:20 left')
  })

  it('exit: counts down to the settlement', () => {
    renderRow({ bet: makeBet({}, on), now: T_TIMES.strikeEnd + 30 })
    expect(screen.getByText(/the exit is read at/).textContent).toContain('(in 04:30)')
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('collecting', () => {
  it('a round that did not play returns the whole stake at once, without a fee', () => {
    const bet = makeBet({ previewPayout: milli(20) }, { bookFinal: true, activated: false, down: 0n })
    const { props } = renderRow({ bet, now: T_TIMES.closeAt + 1 })
    expect(screen.getByText(/The round did not play/).textContent).toMatch(/Your whole stake comes back, without a fee/)
    fireEvent.click(screen.getByRole('button', { name: 'COLLECT 0.02 WETH' }))
    expect(props.onClaim).toHaveBeenCalledWith(bet)
  })

  it('a winner sees the previewed amount', () => {
    const bet = makeBet({ previewPayout: 32_266_666_666_666_666n }, { bookFinal: true, activated: true, outcome: OUTCOME_UP })
    renderRow({ bet, now: T_TIMES.settleAt + 30 })
    expect(screen.getByText(/UP won/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^COLLECT 0\.032266/ })).toBeTruthy()
  })

  it('a loser with nothing to collect gets no button', () => {
    const bet = makeBet(
      { ticket: { stake: milli(20), side: SIDE_DOWN, status: 1 }, previewPayout: 0n },
      { bookFinal: true, activated: true, outcome: OUTCOME_UP },
    )
    renderRow({ bet, now: T_TIMES.settleAt + 30 })
    expect(screen.getByText(/Nothing to collect/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a loser whose stake was partly unmatched collects that part', () => {
    const bet = makeBet({ previewPayout: milli(6) }, { bookFinal: true, activated: true, outcome: OUTCOME_DOWN })
    renderRow({ bet, now: T_TIMES.settleAt + 30 })
    expect(screen.getByText(/Your side lost; the part that did not play comes back: 0.006 WETH/)).toBeTruthy()
  })

  it('a round refunded for a thin price window says so, and that the 1% fee was kept', () => {
    const bet = makeBet({ previewPayout: 19_866_666_666_666_666n }, { bookFinal: true, activated: true, outcome: OUTCOME_REFUND, reason: REASON_THIN })
    renderRow({ bet, now: T_TIMES.settleAt + 30, voidFeePct: '1%' })
    const body = document.querySelector('.rnd-ticket-body')?.textContent ?? ''
    expect(body).toMatch(/^Refunded\. You were UP\./)
    expect(body).toContain("The pool held too little liquidity during the strike or exit window for this round's bank")
    expect(body).toContain('The 1% fee on the matched bank was kept; the rest comes back.')
    expect(screen.getByRole('button', { name: /^COLLECT 0\.019866/ })).toBeTruthy()
  })

  it('other refund reasons are named too', () => {
    const bet = makeBet({ previewPayout: milli(19) }, { bookFinal: true, activated: true, outcome: OUTCOME_REFUND, reason: REASON_GRACE })
    renderRow({ bet, now: T_TIMES.settleAt + 90_000 })
    expect(document.querySelector('.rnd-ticket-body')?.textContent).toMatch(/Nobody settled the round within 24 hours/)
  })

  it('is locked while another transaction is in the wallet', () => {
    const bet = makeBet({ previewPayout: milli(20) }, { bookFinal: true, activated: false, down: 0n })
    renderRow({ bet, now: T_TIMES.closeAt + 1, busy: true })
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('collected', () => {
    const bet = makeBet({ ticket: { stake: milli(20), side: 1, status: TICKET_CLAIMED }, claimedPayout: milli(20) })
    renderRow({ bet, now: T_TIMES.settleAt + 99 })
    expect(screen.getByText(/Collected 0.02 WETH/)).toBeTruthy()
  })
})

describe('the old design is gone from the rows', () => {
  it('never mentions a reveal, a secret or a forfeit', () => {
    for (const now of [T_TIMES.openAt + 1, T_TIMES.closeAt + 1, T_TIMES.strikeStart + 1, T_TIMES.settleAt + 1]) {
      const { unmount } = renderRow({ bet: makeBet({}, { bookFinal: true, activated: true }), now })
      expect(document.body.textContent).not.toMatch(/reveal|secret|forfeit/i)
      unmount()
    }
  })
})
