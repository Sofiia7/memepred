import { useId, useMemo, useState } from 'react'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { countdownFrom } from '../hooks/useNow'
import { ERC20_ABI } from '../lib/contracts'
import { TARGET_CHAIN, TARGET_CHAIN_ID } from '../lib/chain'
import { formatAmount } from '../lib/money'
import { PRICE_JUMP_REFUND_PCT } from '../lib/rules'
import {
  acceptedBank,
  acceptedIfPlaced,
  activationFloor,
  depthAllows,
  largestStakeWithinDepth,
  clockTime,
  durationLabel,
  payoutIfWin,
  percentOf,
  SIDE_DOWN,
  SIDE_UP,
  type RoundSide,
  type RoundTimes,
} from './roundMath'
import { sideCapMismatch, SIDE_RATIO, strikeAndExit } from './roundRules'
import { RoundRulesBlock } from './RoundRulesBlock'
import { RoundTimeline } from './RoundTimeline'
import { betGate } from './betGate'
import { MIN_SECONDS_TO_BET, useRoundTx } from './useRoundTx'
import type { RoundPool } from './useRoundsData'
import type { PoolDepth, RoundsConstants, RoundState } from './roundsClient'

const SYMBOL = 'WETH'
const amt = (v: bigint) => `${formatAmount(v, 18)} ${SYMBOL}`

function safeParse(raw: string): bigint {
  try {
    return parseUnits(raw || '0', 18)
  } catch {
    return 0n
  }
}

function stakeChips(min: bigint, max: bigint): bigint[] {
  const out = new Set<bigint>()
  for (const m of [1n, 2n, 4n]) if (min * m <= max) out.add(min * m)
  out.add(max)
  return [...out].sort((a, b) => (a < b ? -1 : 1))
}

export interface BetPanelProps {
  pool: RoundPool
  duration: number
  roundId: bigint
  index: bigint
  times: RoundTimes
  round?: RoundState
  now: number
  constants?: RoundsConstants
  /** The connected player already holds a bet in this round. */
  alreadyIn: boolean
  /** The pool's depth and the largest bank a round of it may reach now (maxBankOf). */
  depth?: PoolDepth
}

/**
 * The bet form for the round of one pool and duration that takes bets now:
 * the visible sums, the timeline, side and stake within the contract's limits,
 * an estimate of the part of the stake that would play at the current sums,
 * the rules, and one button that approves the exact stake and bets.
 */
export function BetPanel(p: BetPanelProps) {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const tx = useRoundTx()
  const stakeId = useId()
  const c = p.constants

  const [side, setSide] = useState<RoundSide | undefined>()
  const [stakeInput, setStakeInput] = useState<string>(() =>
    c ? formatUnits(c.minStake * 2n <= c.maxStake ? c.minStake * 2n : c.minStake, 18) : '0.01',
  )
  const [ack, setAck] = useState(false)

  const stakeWei = safeParse(stakeInput)
  const stakeOk = !!c && stakeWei >= c.minStake && stakeWei <= c.maxStake
  const chips = useMemo(() => (c ? stakeChips(c.minStake, c.maxStake) : []), [c])
  const up = p.round?.up ?? 0n
  const down = p.round?.down ?? 0n
  // The smallest matched bank with which this round plays: its own snapshot once it has
  // a bet, the current contract values before that.
  const playFloor = p.round && p.round.minBank > 0n ? p.round.playFloor : c ? activationFloor(c.minBank, c.costAllowance) : 0n

  const { data: wethBalance } = useReadContract({
    address: c?.weth,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!c && !!address, refetchInterval: 15_000 },
  })
  const { data: eth } = useBalance({ address, chainId: TARGET_CHAIN_ID, query: { enabled: !!address } })
  const insufficientWeth = wethBalance !== undefined && wethBalance < stakeWei
  const shortfall = insufficientWeth ? stakeWei - (wethBalance ?? 0n) : 0n
  const ethTooLow = shortfall > 0n && eth !== undefined && eth.value < shortfall

  const secondsLeft = p.times.closeAt - p.now
  const limitsText = c ? `${formatAmount(c.minStake, 18)}-${formatAmount(c.maxStake, 18)} ${SYMBOL}` : ''
  const mismatch = sideCapMismatch(c?.chainSideRatio)
  const sideName = side === SIDE_UP ? 'UP' : side === SIDE_DOWN ? 'DOWN' : undefined
  // The depth rule, as the contract applies it in bet(): below the gate no bet at all;
  // otherwise a bet that raises the accepted bank may raise it only up to maxBank.
  const ratio = c?.chainSideRatio ?? 1
  const poolTooThin = !!c && !!p.depth && p.depth.depth < c.gateDepth
  const depthBlocked = !!p.depth && !!side && stakeOk && !depthAllows(up, down, side, stakeWei, p.depth.maxBank, ratio)
  const bankNow = acceptedBank(up, down, ratio)
  const bankWithStake = side ? acceptedBank(side === SIDE_UP ? up + stakeWei : up, side === SIDE_DOWN ? down + stakeWei : down, ratio) : bankNow
  const largestStake = c && p.depth && side ? largestStakeWithinDepth(up, down, side, p.depth.maxBank, c.maxStake, ratio) : undefined

  const gate = betGate({
    isConnected,
    rulesLoaded: !!c,
    rulesMismatch: mismatch,
    paused: !!c?.paused,
    step: tx.state.step,
    alreadyIn: p.alreadyIn,
    secondsLeft,
    minSecondsLeft: MIN_SECONDS_TO_BET,
    side: sideName,
    stakeOk,
    limitsText,
    insufficientWeth,
    poolTooThin,
    depthBlocked,
    acknowledged: ack,
    stakeText: stakeOk ? formatAmount(stakeWei, 18) : stakeInput,
    symbol: SYMBOL,
  })

  function onCta() {
    if (!isConnected) {
      connectWallet()
      return
    }
    if (gate.disabled || !c || !side) return
    void tx.bet({
      roundId: p.roundId,
      side,
      stake: stakeWei,
      closeAt: p.times.closeAt,
      nowSec: p.now,
      minStake: c.minStake,
      maxStake: c.maxStake,
      weth: c.weth,
    })
  }

  const locked = tx.busy
  const timing = c ? { durationSec: p.duration, strikePause: c.strikePause, strikeWindow: c.strikeWindow } : undefined

  return (
    <div className="rnd-bet" aria-label={`Bet on ${p.pool.symbol} ${durationLabel(p.duration)} round`}>
      <div className="rnd-bet-head">
        <b>{p.pool.symbol}</b> · {durationLabel(p.duration)} round #{p.index.toString()} · bets close {clockTime(p.times.closeAt)}{' '}
        (in <b>{countdownFrom(p.times.closeAt, p.now)}</b>)
      </div>

      <div className="rnd-sums" aria-label="Staked so far">
        <div className="rnd-sum up">
          UP so far<b>{amt(up)}</b>
        </div>
        <div className="rnd-sum down">
          DOWN so far<b>{amt(down)}</b>
        </div>
      </div>

      {c && p.depth && (
        <p className={'rnd-note' + (poolTooThin ? ' bad' : '')} aria-label="Pool depth">
          {poolTooThin ? (
            <>
              This pool holds {amt(p.depth.depth)} of depth, below the {amt(c.gateDepth)} a pool needs to take bets. No new bets
              until it is deeper; bets already placed can still be collected.
            </>
          ) : (
            <>
              Pool depth now {amt(p.depth.depth)}: this round can take a matched bank of up to {amt(p.depth.maxBank)} (depth /{' '}
              {c.depthPerBank.toString()}). Matched so far {amt(bankNow)}.
            </>
          )}
        </p>
      )}

      <RoundTimeline times={p.times} now={p.now} />

      <div className="rnd-sides" role="group" aria-label="Side">
        <button type="button" className={'rnd-side up' + (side === SIDE_UP ? ' on' : '')} aria-pressed={side === SIDE_UP} disabled={locked} onClick={() => setSide(SIDE_UP)}>
          UP
        </button>
        <button type="button" className={'rnd-side down' + (side === SIDE_DOWN ? ' on' : '')} aria-pressed={side === SIDE_DOWN} disabled={locked} onClick={() => setSide(SIDE_DOWN)}>
          DOWN
        </button>
      </div>

      <div className="stake-row">
        <div className="stake-input">
          <label className="ccy" htmlFor={stakeId}>
            {SYMBOL}
          </label>
          <input id={stakeId} type="number" inputMode="decimal" step="any" value={stakeInput} disabled={locked} onChange={(e) => setStakeInput(e.target.value)} />
        </div>
      </div>
      <div className="stake-hint">{c ? `${limitsText} per bet · one bet per wallet per round` : 'Reading limits from the contract…'}</div>
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((v) => (
            <button key={v.toString()} className={'chip' + (v === stakeWei ? ' sel' : '')} disabled={locked} onClick={() => setStakeInput(formatUnits(v, 18))}>
              {formatAmount(v, 18)}
            </button>
          ))}
        </div>
      )}

      {/* No estimate for a stake the contract would refuse: the note below says why instead. */}
      {c && side && stakeOk && !p.alreadyIn && !mismatch && !depthBlocked && !poolTooThin && (
        <Estimate stake={stakeWei} side={side} up={up} down={down} playFloor={playFloor} feeBps={c.normalFeeBps} closeAt={p.times.closeAt} />
      )}

      {depthBlocked && p.depth && c && (
        <p className="rnd-note warn" role="alert">
          The pool's depth limits this round's bank: with this stake the matched bank would be {amt(bankWithStake)}, above the{' '}
          {amt(p.depth.maxBank)} the pool backs now.{' '}
          {largestStake !== undefined && largestStake >= c.minStake
            ? `The largest stake on ${sideName} that fits now is ${amt(largestStake)}.`
            : `No stake on ${sideName} fits now; the other side is not limited.`}
        </p>
      )}

      {isConnected && (
        <div className="stake-hint wallet-lines">
          <span>
            {SYMBOL} {wethBalance !== undefined ? formatAmount(wethBalance, 18) : '…'} · ETH {eth ? formatAmount(eth.value, 18) : '…'}
          </span>
          {insufficientWeth && c && (
            <button className="chip wrap-btn" disabled={locked || ethTooLow} onClick={() => void tx.wrap(c.weth, shortfall)}>
              {tx.state.step === 'wrapping' ? 'WRAPPING…' : `WRAP ${formatAmount(shortfall, 18)} ETH`}
            </button>
          )}
        </div>
      )}

      {c && timing && (
        <RoundRulesBlock
          feeBps={c.normalFeeBps}
          voidFeeBps={c.voidFeeBps}
          durationSec={p.duration}
          strikePause={c.strikePause}
          strikeWindow={c.strikeWindow}
          settleGraceSec={c.settleGrace}
          minBank={formatAmount(playFloor, 18)}
          depthPerBank={Number(c.depthPerBank)}
          gateDepth={formatAmount(c.gateDepth, 18)}
          maxStake={formatAmount(c.maxStake, 18)}
          symbol={SYMBOL}
          spreadGuardPct={PRICE_JUMP_REFUND_PCT}
          testnet={!!TARGET_CHAIN.testnet}
        />
      )}

      {mismatch && (
        <p className="rnd-note bad" role="alert">
          The contract caps sides at {c?.chainSideRatio}:1, but this page describes {SIDE_RATIO}:1 matching. Signing is off
          until the site is updated.
        </p>
      )}

      {timing && (
        <p className="rnd-key" role="note">
          <b>You bet on the move from the strike to the exit, not on the price now.</b> {strikeAndExit(timing)}
        </p>
      )}

      <label className="rnd-ack">
        <input type="checkbox" checked={ack} disabled={locked} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand: this bet is decided by the move from the strike average ({clockTime(p.times.strikeStart)}-
          {clockTime(p.times.strikeEnd)}) to the exit ({clockTime(p.times.settleAt)}), not by the price now.
        </span>
      </label>

      <button className={'cta' + (gate.disabled ? ' disabled' : '')} disabled={gate.disabled} onClick={onCta}>
        {locked && <span className="spinner" />}
        {gate.label}
      </button>

      <div className="rnd-steps">
        An approval of exactly this stake, then the bet: up to 2 wallet prompts, plus a wrap if you hold no WETH. After
        the result: collect.
      </div>

      {tx.state.step === 'error' && (
        <div className="rnd-status err" role="alert">
          {tx.state.error}
        </div>
      )}
      {tx.state.step === 'done' && tx.state.note && (
        <div className="rnd-status ok" role="status">
          {tx.state.note}
        </div>
      )}
    </div>
  )
}

/**
 * The part of this stake that would play if the round closed with the sums it
 * has now. Said to be an estimate, every time: the sums change with every bet
 * until the close.
 */
export function Estimate(p: { stake: bigint; side: RoundSide; up: bigint; down: bigint; playFloor: bigint; feeBps: number; closeAt: number }) {
  const other = p.side === SIDE_UP ? p.down : p.up
  const otherName = p.side === SIDE_UP ? 'DOWN' : 'UP'
  const { accepted, returned } = acceptedIfPlaced(p.stake, p.side, p.up, p.down)
  const newUp = p.side === SIDE_UP ? p.up + p.stake : p.up
  const newDown = p.side === SIDE_DOWN ? p.down + p.stake : p.down
  const bank = 2n * (newUp < newDown ? newUp : newDown)
  const change = `These numbers change with every bet until ${clockTime(p.closeAt)}, when bets close.`

  if (other === 0n) {
    return (
      <div className="rnd-estimate" role="status">
        Nobody is on {otherName} yet, so at the current sums none of your stake would play. If nobody bets {otherName} before
        the close, the round does not play and your whole stake comes back.
        <span className="rnd-tone-dim">{change}</span>
      </div>
    )
  }
  return (
    <div className="rnd-estimate" role="status">
      At the current sums, about <b>{amt(accepted)}</b> of your {amt(p.stake)} would play ({percentOf(accepted, p.stake)}%)
      {returned > 0n ? <>, and {amt(returned)} would come back without a fee</> : null}. If your side wins you would collect
      about <b>{amt(payoutIfWin(accepted, returned, p.feeBps))}</b>; if it loses, {amt(returned)}.
      {bank < p.playFloor && (
        <>
          {' '}
          The matched bank would be {amt(bank)}, below the minimum of {amt(p.playFloor)}: unless more is bet, the round does
          not play and every stake comes back.
        </>
      )}
      <span className="rnd-tone-dim">{change}</span>
    </div>
  )
}
