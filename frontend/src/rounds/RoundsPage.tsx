import { useEffect, useId, useMemo, useState } from 'react'
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
import { acceptedBank, bpsToPct, clockTime, currentIndex, durationLabel, formatMultiplier, roundIdOf, roundTimes, SIDE_DOWN, SIDE_UP, sideLabel, winMultiplier, type RoundSide } from './roundMath'
import { fmtPct, pctFromTicks, type TickSample } from './strikeMath'
import { usePoolTicks } from './usePoolTicks'
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
export function RoundsPage({ betsOnly = false }: { betsOnly?: boolean }) {
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
  return <RoundsScreen betsOnly={betsOnly} />
}

const SYMBOL = ROUNDS_CONFIG.nativeEth ? 'ETH' : 'WETH'
const amt = (v: bigint) => `${formatAmount(v, 18)} ${SYMBOL}`

function RoundsScreen({ betsOnly }: { betsOnly: boolean }) {
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
        title={betsOnly ? 'My bets' : 'Rounds'}
        live
        liveLabel={TARGET_CHAIN.testnet ? 'testnet preview' : 'preview'}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        }
      />
      {!betsOnly && <p className="rnd-lead">
        Call the next move of a meme coin: UP or DOWN, a new round every 5 minutes, the winning side takes{' '}
        {c ? formatMultiplier(winMultiplier(c.normalFeeBps)) : '1.96x'}. Both sides must be in for a round to play; if not,
        every stake comes back. The result compares prices measured after betting closes.
        {TARGET_CHAIN.testnet ? ' Test ETH; these test pools move on scripted prices.' : ''}
      </p>}
      {betsOnly && <p className="rnd-lead">Your open bets, results and collections from this wallet.</p>}

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
              const originalPool = poolOfRound(bet.roundId)
              const replacement = delisted.has(originalPool.toLowerCase())
                ? markets.data?.pools.find((p) => p.symbol === symbolOf(originalPool)) : undefined
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
                  nextRoundId={replacement ? roundIdOf(replacement.pool, bet.round.duration, currentIndex(now, bet.round.duration)) : undefined}
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

      {!betsOnly && <>
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
      </>}
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
  const ticks = usePoolTicks(p.pool.pool, p.pool.wethIsToken0, p.now)
  const move = moveOver(ticks, p.now, 300)
  const moveTone = move === null ? '' : move > 0 ? 'up' : move < 0 ? 'down' : ''
  const mult = p.constants ? formatMultiplier(winMultiplier(p.constants.normalFeeBps)) : undefined
  const [chosen, setChosen] = useState<RoundSide | undefined>()
  return (
    <div className="rnd-pool" id={`pool-${p.pool.pool.toLowerCase()}`}>
      <div className="rnd-pool-head">
        <span className="rnd-pool-sym">{p.pool.symbol}</span>
        <span className={'rnd-pool-move ' + moveTone} aria-label="Price move over the last 5 minutes">
          {move === null ? (ticks.length ? 'price steady' : 'reading price…') : `${fmtPct(move)} · 5 min`}
        </span>
      </div>
      {TARGET_CHAIN.id === 46630 && <div className="rnd-demo-feed">TESTNET DEMO FEED · simulated pool prices</div>}
      <Sparkline ticks={ticks} now={p.now} />
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
        const left = times.closeAt - p.now
        const soon = left <= 60
        const progress = Math.min(100, Math.max(0, ((p.now - times.openAt) / d) * 100))
        const up = round?.up ?? 0n
        const down = round?.down ?? 0n
        const hint = !round
          ? 'reading the book…'
          : up === 0n && down === 0n
            ? 'Nobody in yet. The first bet sets the pace.'
            : up === 0n
              ? `DOWN is in, UP is empty: take UP and the round plays.`
              : down === 0n
                ? `UP is in, DOWN is empty: take DOWN and the round plays.`
                : `${amt(acceptedBank(up, down, p.constants?.chainSideRatio ?? 1))} matched${mult ? `, ${mult} to the winning side` : ''}.`
        const choose = (side: RoundSide) => {
          setChosen(side)
          if (!open) p.onToggle(key)
        }
        const preset = chosen ?? p.presetSide
        return (
          <div key={d}>
            <div className="rnd-round rnd-round-live">
              <div className="rnd-round-main">
                <div className="rnd-count-row">
                  <span className={'rnd-count' + (soon ? ' soon' : '')} aria-label="Bets close in">
                    {countdownFrom(times.closeAt, p.now)}
                  </span>
                  <span className="rnd-count-label">
                    to close · {durationLabel(d)} round{mult ? ` · pays ${mult}` : ''}
                  </span>
                </div>
                <div className="rnd-progress" aria-hidden="true">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="rnd-round-sub">
                  {round ? `UP ${amt(up)} · DOWN ${amt(down)}` : 'reading…'}
                  {myBet ? ` · YOUR ${sideLabel(myBet.ticket.side)} ${amt(myBet.ticket.stake)}` : ''}
                </div>
                <div className="rnd-round-hint">{hint}</div>
              </div>
              <div className="rnd-side-btns">
                {alreadyIn ? (
                  <button className={'rnd-btn' + (open ? ' ghost' : '')} aria-expanded={open} onClick={() => p.onToggle(key)}>
                    {open ? 'CLOSE' : 'YOUR BET'}
                  </button>
                ) : (
                  <>
                    <button type="button" className={'rnd-go up' + (open && preset === SIDE_UP ? ' on' : '')} aria-pressed={open && preset === SIDE_UP} onClick={() => choose(SIDE_UP)}>
                      UP
                    </button>
                    <button type="button" className={'rnd-go down' + (open && preset === SIDE_DOWN ? ' on' : '')} aria-pressed={open && preset === SIDE_DOWN} onClick={() => choose(SIDE_DOWN)}>
                      DOWN
                    </button>
                  </>
                )}
              </div>
            </div>
            {open && (
              // Keyed by round and chosen side: when the window rolls over, the form starts clean, and a
              // side picked on the card opens the form with it. Its confirmation names this round's
              // strike and exit times, so it must not carry over to the next one.
              <BetPanel
                key={`${roundId.toString()}:${preset ?? ''}`}
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
                presetSide={preset}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Percent move from the sample `window` seconds ago (or the earliest, when the series is younger) to the latest. */
function moveOver(ticks: TickSample[], now: number, window: number): number | null {
  if (ticks.length < 2) return null
  const latest = ticks[ticks.length - 1]
  let from = ticks[0]
  for (const s of ticks) if (s.t <= now - window) from = s
  return pctFromTicks(latest.tick, from.tick)
}

/** The last ten minutes of the pool's price as a small line, the latest point marked. */
function Sparkline(p: { ticks: TickSample[]; now: number }) {
  const gradient = useId().replace(/:/g, '')
  const w = 600
  const h = 110
  const pts = p.ticks.filter((s) => s.t >= p.now - 600)
  if (pts.length < 2) return <div className="rnd-demo-feed">Loading recent pool prices…</div>
  const base = pts[0].tick
  const ys = pts.map((s) => pctFromTicks(s.tick, base))
  const lo = Math.min(...ys), hi = Math.max(...ys)
  const mid = (lo + hi) / 2
  const span = Math.max(hi - lo, 0.4)
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1)
  const X = (t: number) => 8 + ((t - t0) / (t1 - t0)) * (w - 20)
  const Y = (v: number) => 8 + ((mid + span / 2 - v) / span) * (h - 32)
  const d = pts.map((s, i) => `${i ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ')
  const last = ys[ys.length - 1]
  return (
    <svg className="rnd-spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Recent pool price history: historical averages and live prices">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--up)" stopOpacity=".18" /><stop offset="100%" stopColor="var(--up)" stopOpacity="0" /></linearGradient></defs>
      {[16, 47, 78].map((y) => <line key={y} x1="8" x2={w - 12} y1={y} y2={y} className="rnd-spark-grid" />)}
      <path d={`${d} L${X(t1)},${h - 24} L${X(t0)},${h - 24} Z`} fill={`url(#${gradient})`} />
      <path d={d} className="rnd-spark-line" />
      <circle cx={X(pts[pts.length - 1].t)} cy={Y(last)} r="3.5" className={'rnd-spark-dot ' + (last > 0 ? 'up' : last < 0 ? 'down' : '')} />
      <text x="8" y={h - 3} className="rnd-spark-axis">{clockTime(t0)}</text>
      <text x={w - 12} y={h - 3} className="rnd-spark-axis" textAnchor="end">{clockTime(t1)}</text>
    </svg>
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
