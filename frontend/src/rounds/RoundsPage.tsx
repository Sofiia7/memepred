import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { ScreenTitle } from '../components/ui/AppShell'
import { ApiError } from '../components/ui/ApiError'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { countdownFrom } from '../hooks/useNow'
import { TARGET_CHAIN } from '../lib/chain'
import { formatAmount } from '../lib/money'
import { shortAddr } from '../lib/symbols'
import { ROUNDS_CONFIG } from './roundsAbi'
import { bpsToPct, clockTime, currentIndex, durationLabel, roundIdOf, roundTimes, sideLabel, type RoundSide } from './roundMath'
import { parseChallenge } from './challenge'
import type { RoundsConstants, RoundState } from './roundsClient'
import { urgency } from './ticketState'
import { BetPanel } from './BetPanel'
import { TicketRow, viewOf } from './TicketRow'
import { useChainClock } from './useChainClock'
import { useRoundTx } from './useRoundTx'
import { poolOfRound, useCurrentRounds, useMyBets, usePoolDepth, useRoundMarkets, useRoundsConstants, type MyBet, type RoundPool } from './useRoundsData'
import './rounds.css'

/**
 * /rounds: shared-bank rounds on PoolRounds, redesigned 2026-09-29 (visible
 * bets, sides matched 1:1, a pause before the strike).
 *
 * Mounted only when the build sets VITE_ROUNDS_ENABLED=1 (App.tsx), inside the
 * same GeoGate and RiskGate as every other screen, so the region check and the
 * unaudited-contracts notice apply here unchanged.
 */
export function RoundsPage() {
  const cfg = ROUNDS_CONFIG
  if (!cfg.address || cfg.problems.length > 0) {
    return (
      <>
        <ScreenTitle title="Rounds" />
        <div className="rnd-note bad" role="alert">
          Rounds are switched on in this build but not configured:
          <ul style={{ margin: '6px 0 0 18px' }}>
            {(cfg.problems.length ? cfg.problems : ['VITE_POOL_ROUNDS_ADDRESS']).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      </>
    )
  }
  return <RoundsScreen />
}

const SYMBOL = ROUNDS_CONFIG.nativeEth ? 'ETH' : 'WETH'
const amt = (v: bigint) => `${formatAmount(v, 18)} ${SYMBOL}`

function RoundsScreen() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const { hash, search } = useLocation()
  const { now } = useChainClock()
  const constants = useRoundsConstants()
  const markets = useRoundMarkets()
  const current = useCurrentRounds(markets.data, now)
  const mine = useMyBets(address)
  const tx = useRoundTx()
  const [openKey, setOpenKey] = useState<string | null>(null)
  // A challenge link: the round, the side on offer and the challenger (rounds/challenge.ts).
  const challenge = useMemo(() => parseChallenge(search), [search])
  const [seeded, setSeeded] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const c = constants.data
  const ratio = c?.chainSideRatio ?? 1

  const symbols = useMemo(
    () => new Map([...(markets.data?.pools ?? []), ...(markets.data?.delisted ?? [])].map((p) => [p.pool.toLowerCase(), p.symbol])),
    [markets.data],
  )
  const delisted = useMemo(() => new Set((markets.data?.delisted ?? []).map((p) => p.pool.toLowerCase())), [markets.data])
  const orientation = useMemo(
    () => new Map([...(markets.data?.pools ?? []), ...(markets.data?.delisted ?? [])].filter((p) => p.wethIsToken0 !== undefined).map((p) => [p.pool.toLowerCase(), p.wethIsToken0 as boolean])),
    [markets.data],
  )
  const symbolOf = (pool: Address) => symbols.get(pool.toLowerCase()) ?? shortAddr(pool)

  const bets = useMemo(() => {
    const list = [...(mine.data?.bets ?? [])]
    list.sort((a, b) => urgency(viewOf(a, now, ratio).kind) - urgency(viewOf(b, now, ratio).kind) || b.round.times.closeAt - a.round.times.closeAt)
    return list
  }, [mine.data, now, ratio])
  const myRounds = useMemo(() => new Map((mine.data?.bets ?? []).filter((b) => b.contract.toLowerCase() === ROUNDS_CONFIG.address?.toLowerCase()).map((b) => [b.roundId.toString(), b])), [mine.data])

  useEffect(() => {
    if (!hash || !mine.data) return
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' })
  }, [hash, mine.data])

  // The challenged round's pool and length, if listed: its form opens with the offered side.
  const challengeKey = challenge ? `${challenge.pool}:${challenge.duration}` : null
  const challengeListed = !!challenge && (markets.data?.pools ?? []).some((p) => p.pool.toLowerCase() === challenge.pool.toLowerCase()) && (markets.data?.durations ?? []).includes(challenge.duration)
  const challengeLive = !!challenge && currentIndex(now, challenge.duration) === challenge.index
  useEffect(() => {
    if (seeded || !challengeKey || !markets.data) return
    setSeeded(true)
    if (!challengeListed) return
    setOpenKey(challengeKey)
    setTimeout(() => document.getElementById(`pool-${challenge!.pool.toLowerCase()}`)?.scrollIntoView({ block: 'start' }), 50)
  }, [seeded, challengeKey, challengeListed, markets.data, challenge])

  const onClaim = (b: MyBet) => {
    setActingId(`${b.contract}:${b.roundId}`)
    void tx.claim(b)
  }

  return (
    <>
      <ScreenTitle
        title="Rounds"
        live
        liveLabel={TARGET_CHAIN.testnet ? 'testnet preview' : 'preview'}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        }
      />
      <p className="rnd-lead">
        Pick a coin and bet UP or DOWN with test ETH. Both sides need enough stake for the round to play; otherwise you
        can collect a full refund. The result uses prices measured after betting closes.
      </p>

      {c?.paused && (
        <p className="rnd-note warn" role="status">
          New bets are paused. Collecting still works.
        </p>
      )}
      {challenge && markets.data && (
        <ChallengeBanner
          symbol={symbolOf(challenge.pool)}
          take={challenge.take}
          listed={challengeListed}
          live={challengeLive}
          round={challengeLive ? current.data?.get(challenge.roundId.toString()) : undefined}
          closeAt={challengeLive ? (current.data?.get(challenge.roundId.toString())?.times.closeAt ?? Number(challenge.index + 1n) * challenge.duration) : undefined}
          now={now}
        />
      )}
      {constants.isError && <ApiError message="Couldn't read the rounds contract" onRetry={() => void constants.refetch()} />}

      {isConnected ? (
        <>
          <div className="rnd-section" id="your-bets">Your bets</div>
          {mine.data?.scanError && (
            <p className="rnd-note warn">Could not read your bets from the chain ({mine.data.scanError}).</p>
          )}
          {mine.isLoading && <p className="rnd-note">Reading your bets from the chain…</p>}
          {mine.data && bets.length === 0 && <p className="rnd-note">No bets from this wallet yet.</p>}
          <div className="rnd-list">
            {bets.map((bet) => {
              const id = `${bet.contract}:${bet.roundId}`
              return (
                <TicketRow
                  key={id}
                  bet={bet}
                  now={now}
                  symbol={symbolOf(poolOfRound(bet.roundId))}
                  tx={actingId === id ? tx.state : { step: 'idle' }}
                  busy={tx.busy}
                  ratio={ratio}
                  poolDelisted={delisted.has(poolOfRound(bet.roundId).toLowerCase())}
                  voidFeePct={c ? bpsToPct(c.voidFeeBps) : undefined}
                  me={address}
                  wethIsToken0={orientation.get(poolOfRound(bet.roundId).toLowerCase())}
                  onClaim={onClaim}
                />
              )
            })}
          </div>
        </>
      ) : (
        <p className="rnd-note">
          <button className="rnd-btn ghost" onClick={() => connectWallet()}>
            CONNECT WALLET
          </button>{' '}
          to bet and to see your bets.
        </p>
      )}

      <div className="rnd-section">Pools</div>
      {markets.isLoading && <p className="rnd-note">Reading the chain…</p>}
      {markets.isError && <ApiError message="Couldn't load the pools" onRetry={() => void markets.refetch()} />}
      {markets.data?.scanError && (
        <p className="rnd-note warn">Could not scan the contract's pool list ({markets.data.scanError}). Showing pools from the feed.</p>
      )}
      {markets.data && markets.data.pools.length === 0 && <p className="rnd-note">No pools take bets on the rounds contract yet.</p>}
      {markets.data && markets.data.pools.length > 0 && markets.data.durations.length === 0 && (
        <p className="rnd-note">No round length is switched on in the contract.</p>
      )}

      <div className="rnd-list">
        {(markets.data?.pools ?? []).map((pool) => (
          <PoolCard
            key={pool.pool}
            pool={pool}
            durations={markets.data?.durations ?? []}
            now={now}
            rounds={current.data}
            constants={c}
            myRounds={myRounds}
            openKey={openKey}
            presetSide={challengeListed && challenge && pool.pool.toLowerCase() === challenge.pool.toLowerCase() ? challenge.take : undefined}
            onToggle={(k) => setOpenKey((cur) => (cur === k ? null : k))}
          />
        ))}
      </div>
    </>
  )
}

function PoolCard(p: {
  pool: RoundPool
  durations: number[]
  now: number
  rounds?: Map<string, RoundState>
  constants?: RoundsConstants
  myRounds: Map<string, MyBet>
  openKey: string | null
  /** The side a challenge link offers on this pool; the form opens with it chosen. */
  presetSide?: RoundSide
  onToggle: (key: string) => void
}) {
  const depth = usePoolDepth(p.pool.pool).data
  const thin = !!depth && !!p.constants && depth.depth < p.constants.gateDepth
  return (
    <div className="rnd-pool" id={`pool-${p.pool.pool.toLowerCase()}`}>
      <div className="rnd-pool-head">
        <span className="rnd-pool-sym">{p.pool.symbol}</span>
        <span className="rnd-pool-addr">{shortAddr(p.pool.pool)}</span>
      </div>
      {thin && <div className="rnd-round-sub rnd-tone-bad">Pool liquidity is too low for new bets</div>}
      {p.durations.map((d) => {
        const index = currentIndex(p.now, d)
        const roundId = roundIdOf(p.pool.pool, d, index)
        const round = p.rounds?.get(roundId.toString())
        // The contract's own times once read; until then its layout from the constants.
        const times = round?.times ?? roundTimes(d, index, p.constants?.strikePause ?? 0, p.constants?.strikeWindow ?? 0)
        const key = `${p.pool.pool}:${d}`
        const open = p.openKey === key
        const myBet = p.myRounds.get(roundId.toString())
        const alreadyIn = !!myBet
        return (
          <div key={d}>
            <div className="rnd-round">
              <div className="rnd-round-main">
                <div className="rnd-round-top">
                  <span className="rnd-dur">{durationLabel(d)} round</span>
                  <span>bets close in {countdownFrom(times.closeAt, p.now)}</span>
                </div>
                <div className="rnd-round-sub">
                  {round ? `UP ${amt(round.up)} · DOWN ${amt(round.down)}` : 'reading…'}
                  {myBet ? ` · YOUR ${sideLabel(myBet.ticket.side)} ${amt(myBet.ticket.stake)}` : ''}
                </div>
              </div>
              <button className={'rnd-btn' + (open ? ' ghost' : '')} aria-expanded={open} onClick={() => p.onToggle(key)}>
                {open ? 'CLOSE' : alreadyIn ? 'YOUR BET' : 'BET'}
              </button>
            </div>
            {open && (
              // Keyed by round: when the window rolls over, the form starts clean. Its confirmation
              // names this round's strike and exit times, so it must not carry over to the next one.
              <BetPanel
                key={roundId.toString()}
                pool={p.pool}
                duration={d}
                roundId={roundId}
                index={index}
                times={times}
                round={round}
                now={p.now}
                constants={p.constants}
                alreadyIn={alreadyIn}
                depth={depth}
                presetSide={p.presetSide}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * What a challenge link says on arrival: the round is still taking bets (take
 * the offered side before the close), it has closed (the pool's next round is
 * open, same side preselected), or the pool is not listed here.
 */
function ChallengeBanner(p: { symbol: string; take: RoundSide; listed: boolean; live: boolean; round?: RoundState; closeAt?: number; now: number }) {
  const take = sideLabel(p.take)
  const other = sideLabel(p.take === 1 ? 2 : 1)
  if (!p.listed) {
    return (
      <div className="rnd-challenge closed" role="status">
        You were challenged on <b>{p.symbol}</b>, but that pool does not take bets here. Pick another pool below.
      </div>
    )
  }
  if (!p.live) {
    return (
      <div className="rnd-challenge closed" role="status">
        <b>You were challenged to take {take} on {p.symbol}</b>, but that round has closed. The next {p.symbol} round is
        open below with {take} preselected.
      </div>
    )
  }
  const other_sum = p.round ? (p.take === 1 ? p.round.down : p.round.up) : undefined
  return (
    <div className="rnd-challenge" role="status">
      <b>Someone bet {other} on {p.symbol} and dares you to take {take}.</b>{' '}
      {other_sum !== undefined && other_sum > 0n ? `${amt(other_sum)} is on ${other} already. ` : ''}
      {p.closeAt ? (
        <>
          Bets close at <b>{clockTime(p.closeAt)}</b> (in {countdownFrom(p.closeAt, p.now)}). The form below has {take} chosen.
        </>
      ) : null}
    </div>
  )
}
