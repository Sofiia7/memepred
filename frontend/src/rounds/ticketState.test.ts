import { describe, it, expect } from 'vitest'
import { describeTicket, urgency, type TicketInput } from './ticketState'
import { SIDE_DOWN, SIDE_UP } from './roundMath'
import { OUTCOME_DOWN, OUTCOME_NONE, OUTCOME_TIE, OUTCOME_UP, TICKET_CLAIMED, TICKET_NONE, TICKET_PLACED } from './roundsClient'
import { T_TIMES as T, milli } from './testFixtures'

function input(over: Partial<TicketInput>): TicketInput {
  return {
    times: T,
    now: T.openAt + 10,
    status: TICKET_PLACED,
    stake: milli(20),
    side: SIDE_UP,
    up: milli(30),
    down: milli(20),
    bookFinal: false,
    activated: false,
    outcome: OUTCOME_NONE,
    ...over,
  }
}

describe('bets open', () => {
  it('shows the part that would play at the current sums and counts down to the close', () => {
    const v = describeTicket(input({ now: T.closeAt - 1 }))
    expect(v.kind).toBe('open')
    expect(v.deadline).toBe(T.closeAt)
    expect(v.accepted + v.returned).toBe(milli(20))
    expect(v.accepted).toBe((milli(20) * milli(20)) / milli(30))
    expect(v.action).toBeUndefined()
  })
})

describe('after the close', () => {
  it('does not call a round "not played" on a read taken before the close', () => {
    const v = describeTicket(input({ now: T.closeAt + 1, bookFinal: false }))
    expect(v.kind).toBe('closing')
    expect(v.action).toBeUndefined()
  })

  it('a round that did not play: the whole stake, collectable at once', () => {
    const v = describeTicket(input({ now: T.closeAt, bookFinal: true, activated: false, down: 0n }))
    expect(v).toMatchObject({ kind: 'refund', action: 'claim', payout: milli(20), accepted: 0n, returned: milli(20) })
  })

  it('a round that plays walks through pause, strike and exit, each with its own countdown', () => {
    const on = { bookFinal: true, activated: true }
    expect(describeTicket(input({ ...on, now: T.closeAt }))).toMatchObject({ kind: 'pause', deadline: T.strikeStart })
    expect(describeTicket(input({ ...on, now: T.strikeStart }))).toMatchObject({ kind: 'strike', deadline: T.strikeEnd })
    expect(describeTicket(input({ ...on, now: T.strikeEnd }))).toMatchObject({ kind: 'exit', deadline: T.settleAt })
    expect(describeTicket(input({ ...on, now: T.settleAt })).kind).toBe('waiting-result')
    for (const now of [T.closeAt, T.strikeStart, T.strikeEnd, T.settleAt]) expect(describeTicket(input({ ...on, now })).action).toBeUndefined()
  })
})

describe('settled', () => {
  const done = { bookFinal: true, activated: true, now: T.settleAt + 5 }

  it('a winner collects what previewClaim says', () => {
    const v = describeTicket(input({ ...done, outcome: OUTCOME_UP, previewPayout: milli(30) }))
    expect(v).toMatchObject({ kind: 'claimable', action: 'claim', won: true, payout: milli(30) })
  })

  it('a loser with an unmatched part collects that part', () => {
    const v = describeTicket(input({ ...done, outcome: OUTCOME_DOWN, previewPayout: milli(6) }))
    expect(v).toMatchObject({ kind: 'claimable', won: false })
  })

  it('a loser with nothing to collect is shown as lost, with no button', () => {
    const v = describeTicket(input({ ...done, side: SIDE_DOWN, outcome: OUTCOME_UP, previewPayout: 0n }))
    expect(v).toMatchObject({ kind: 'lost', won: false })
    expect(v.action).toBeUndefined()
  })

  it('a tie is neither a win nor a loss', () => {
    expect(describeTicket(input({ ...done, outcome: OUTCOME_TIE, previewPayout: milli(19) })).won).toBeUndefined()
  })

  it('a settled round whose preview has not been read yet waits instead of guessing', () => {
    expect(describeTicket(input({ ...done, outcome: OUTCOME_UP })).kind).toBe('waiting-result')
  })

  it('collected is collected', () => {
    expect(describeTicket(input({ status: TICKET_CLAIMED, claimedPayout: 5n })).kind).toBe('claimed')
    expect(describeTicket(input({ status: TICKET_NONE })).kind).toBe('none')
  })
})

describe('urgency', () => {
  it('puts something to collect first', () => {
    expect(urgency('claimable')).toBeLessThan(urgency('open'))
    expect(urgency('refund')).toBeLessThan(urgency('strike'))
    expect(urgency('open')).toBeLessThan(urgency('claimed'))
  })
})
