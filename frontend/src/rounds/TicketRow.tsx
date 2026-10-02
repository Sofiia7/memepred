import { countdownFrom } from '../hooks/useNow'
import { formatAmount } from '../lib/money'
import { clockTime, percentOf, sideLabel } from './roundMath'
import { describeTicket, outcomeLabel, refundReasonText, type TicketView } from './ticketState'
import { OUTCOME_REFUND, OUTCOME_TIE } from './roundsClient'
import type { MyBet } from './useRoundsData'
import type { TxState } from './useRoundTx'
import { ROUNDS_CONFIG } from './roundsAbi'

const SYMBOL = ROUNDS_CONFIG.nativeEth ? 'ETH' : 'WETH'
const amt = (v: bigint | undefined) => (v === undefined ? '-' : `${formatAmount(v, 18)} ${SYMBOL}`)

export interface TicketRowProps {
  bet: MyBet
  now: number
  symbol: string
  tx: TxState
  busy: boolean
  /** The void fee as the rules state it ("1%"), for the refund explanation. */
  voidFeePct?: string
  /** The contract's side cap, for the part of a stake that plays. */
  ratio?: number
  /** The pool no longer takes new bets (delisted, for example below the depth gate). */
  poolDelisted?: boolean
  onClaim: (bet: MyBet) => void
}

export function viewOf(bet: MyBet, now: number, ratio = 1): TicketView {
  return describeTicket({
    times: bet.round.times,
    now,
    status: bet.ticket.status,
    stake: bet.ticket.stake,
    side: bet.ticket.side,
    up: bet.round.up,
    down: bet.round.down,
    bookFinal: bet.round.bookFinal,
    activated: bet.round.activated,
    outcome: bet.round.outcome,
    previewPayout: bet.previewPayout,
    claimedPayout: bet.claimedPayout,
    ratio,
  })
}

const STATE_LABEL: Record<TicketView['kind'], { text: string; tone: string }> = {
  none: { text: 'no bet', tone: 'rnd-tone-dim' },
  open: { text: 'bets open', tone: 'rnd-tone-dim' },
  closing: { text: 'closed', tone: 'rnd-tone-dim' },
  refund: { text: 'refunded', tone: 'rnd-tone-warn' },
  pause: { text: 'pause', tone: 'rnd-tone-dim' },
  strike: { text: 'strike', tone: 'rnd-tone-warn' },
  exit: { text: 'to the exit', tone: 'rnd-tone-dim' },
  'waiting-result': { text: 'waiting for result', tone: 'rnd-tone-dim' },
  claimable: { text: 'ready to collect', tone: 'rnd-tone-good' },
  lost: { text: 'lost', tone: 'rnd-tone-bad' },
  claimed: { text: 'collected', tone: 'rnd-tone-dim' },
}

/**
 * One of the player's bets, where its round is on the timeline, and the one
 * thing it may need: Collect. Countdowns run to the close, to the strike and
 * to the settlement, from the chain clock.
 */
export function TicketRow(p: TicketRowProps) {
  const v = viewOf(p.bet, p.now, p.ratio)
  const { times, outcome, up, down, playFloor } = p.bet.round
  const label = STATE_LABEL[v.kind]
  const side = sideLabel(p.bet.ticket.side)
  const stake = p.bet.ticket.stake
  const matchedLine = (
    <>
      <b>{amt(v.accepted)}</b> of your stake plays ({percentOf(v.accepted, stake)}%)
      {v.returned > 0n ? <>, {amt(v.returned)} comes back without a fee</> : null}
    </>
  )

  return (
    <div className={'rnd-ticket' + (v.action ? ' urgent' : '')} id={`round-${p.bet.contract}-${p.bet.roundId.toString()}`} data-kind={v.kind}>
      <div className="rnd-ticket-head">
        <span>
          <b>{p.symbol}</b> · {side} · <b>{amt(stake)}</b>
        </span>
        <span className={'rnd-ticket-state ' + label.tone}>{label.text}</span>
      </div>

      {p.bet.contract.toLowerCase() !== ROUNDS_CONFIG.address?.toLowerCase() && (
        <div className="rnd-ticket-body rnd-tone-warn">
          Previous contract: this bet cannot match bets on the current contract. Any refund or payout remains here and can
          be collected separately.{' '}
          <a href={`https://explorer.testnet.chain.robinhood.com/address/${p.bet.contract}`} target="_blank" rel="noreferrer">View contract</a>
        </div>
      )}

      {v.kind === 'open' && (
        <div className="rnd-ticket-body">
          Bets close at <b>{clockTime(times.closeAt)}</b> (in {countdownFrom(times.closeAt, p.now)}). Now UP {amt(up)}, DOWN{' '}
          {amt(down)}: at these sums {matchedLine}. This changes until the close.
        </div>
      )}

      {v.kind === 'closing' && <div className="rnd-ticket-body">Bets are closed. Reading the final sums…</div>}

      {v.kind === 'refund' && (
        <>
          <div className="rnd-ticket-body">
            {up > 0n && down > 0n ? 'Both sides had bets, but only ' : 'There was no bet on the other side, so only '}{amt(2n * (up < down ? up : down))} was matched (UP {amt(up)}, DOWN {amt(down)}). This round needed {amt(playFloor)} matched. Your full stake is refundable without a fee: <b>{amt(v.payout)}</b>.
          </div>
          <ClaimButton {...p} payout={v.payout} />
        </>
      )}

      {v.kind === 'pause' && (
        <div className="rnd-ticket-body">
          The round plays: {matchedLine}. Pause: nothing is priced yet. The strike average starts at{' '}
          <b>{clockTime(times.strikeStart)}</b> (in {countdownFrom(times.strikeStart, p.now)}).
        </div>
      )}

      {v.kind === 'strike' && (
        <div className="rnd-ticket-body">
          The round plays: {matchedLine}. The strike price is being averaged until <b>{clockTime(times.strikeEnd)}</b> (
          {countdownFrom(times.strikeEnd, p.now)} left). The result is due at {clockTime(times.settleAt)}.
        </div>
      )}

      {v.kind === 'exit' && (
        <div className="rnd-ticket-body">
          The round plays: {matchedLine}. The strike is set; the exit is read at <b>{clockTime(times.settleAt)}</b> (in{' '}
          {countdownFrom(times.settleAt, p.now)}).
        </div>
      )}

      {v.kind === 'waiting-result' && (
        <div className="rnd-ticket-body">
          The round plays: {matchedLine}. Due since {clockTime(times.settleAt)}; waiting for someone to settle it. Nothing to do
          until then.
        </div>
      )}

      {(v.kind === 'claimable' || v.kind === 'lost') && (
        <>
          <div className="rnd-ticket-body">
            <b>{outcomeLabel(outcome)}.</b> You were <b>{side}</b>.{' '}
            {v.kind === 'lost'
              ? 'Nothing to collect.'
              : outcome === OUTCOME_REFUND
                ? `${refundReasonText(p.bet.round.reason, p.voidFeePct ?? '1%')} To collect: ${amt(v.payout)}.`
                : outcome === OUTCOME_TIE
                ? `The part that played comes back minus the fee, with the part that did not: ${amt(v.payout)}.`
                : v.won
                  ? `You won: ${amt(v.payout)} to collect.`
                  : `Your side lost; the part that did not play comes back: ${amt(v.payout)}.`}
          </div>
          {v.kind === 'claimable' && <ClaimButton {...p} payout={v.payout} />}
        </>
      )}

      {v.kind === 'claimed' && (
        <div className="rnd-ticket-body">
          {outcome ? `${outcomeLabel(outcome)}. ` : ''}Collected{v.payout !== undefined ? ` ${amt(v.payout)}` : ''}.
        </div>
      )}

      {p.poolDelisted && v.kind !== 'claimed' && v.kind !== 'lost' && (
        <div className="rnd-ticket-body rnd-tone-dim">
          This pool no longer takes new bets (it fell below the depth needed). This bet still runs to the end and can be
          collected as usual.
        </div>
      )}

      {p.tx.step === 'error' && v.action && (
        <div className="rnd-status err" role="alert">
          {p.tx.error}
        </div>
      )}
      {p.tx.step === 'done' && p.tx.note && v.kind !== 'claimed' && (
        <div className="rnd-status ok" role="status">
          {p.tx.note}
        </div>
      )}
    </div>
  )
}

function ClaimButton(p: TicketRowProps & { payout?: bigint }) {
  return (
    <div className="rnd-actions">
      <button className="rnd-btn" disabled={p.busy} onClick={() => p.onClaim(p.bet)}>
        {p.tx.step === 'claiming' ? 'COLLECTING…' : `COLLECT ${amt(p.payout)}`}
      </button>
    </div>
  )
}
