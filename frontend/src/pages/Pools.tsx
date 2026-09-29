import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePools, type Pool, type PoolStatus } from '../hooks/usePools'
import { useMarkets, type Market } from '../hooks/useMarkets'
import { useFreshness } from '../hooks/useFreshness'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { ApiError } from '../components/ui/ApiError'
import { CURRENCY_SYMBOL } from '../lib/contracts'
import { addressToFeedId, formatDuration } from '../lib/symbols'
import '../order.css'

/**
 * What the keeper has seen and what it decided about it.
 *
 * The Base product has a fixed list of feeds somebody whitelisted, so there is
 * nothing to browse. Here 496 pools are created a day and most will never be
 * tradeable, so the interesting screen is not "these are the markets" but
 * "these are the pools, and here is why some of them have no market yet".
 *
 * That is why the reason is shown rather than hidden behind a status chip. A
 * trader whose token has no market wants the sentence, and the sentence is the
 * one the watcher itself wrote.
 */
const STATUS_LABEL: Record<PoolStatus, string> = {
  ONBOARDED: 'trading',
  READY: 'opening',
  PENDING: 'waiting',
  REJECTED: 'not eligible',
}

const STATUS_TONE: Record<PoolStatus, string> = {
  ONBOARDED: '#3ddc97',
  READY: '#4d8dff',
  PENDING: '#c9a227',
  REJECTED: '#7a7f87',
}

function age(sec: number): string {
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  if (sec < 172800) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

/**
 * The market behind one duration chip.
 *
 * The pools API only returns durations. A market is stored under its pool's
 * address left-padded to 32 bytes (feedId), so the address a chip has to link
 * to comes from the markets list, matched on that padded id and the duration.
 */
export function marketIndex(markets: Market[] | undefined): Map<string, Market> {
  const index = new Map<string, Market>()
  for (const m of markets ?? []) index.set(`${m.feedId.toLowerCase()}:${m.duration}`, m)
  return index
}

export function marketForChip(index: Map<string, Market>, pool: string, durationSec: number): Market | undefined {
  return index.get(`${addressToFeedId(pool)}:${durationSec}`)
}

function PoolRow({ p, index }: { p: Pool; index: Map<string, Market> }) {
  return (
    <div className="pool-row">
      <div className="pool-head">
        <span className="pool-sym">{p.symbol ?? `${p.pool.slice(0, 8)}…`}</span>
        <span className="pool-status" style={{ color: STATUS_TONE[p.status] }}>
          {STATUS_LABEL[p.status]}
        </span>
      </div>

      <div className="pool-meta">
        <span>
          {p.wethDepth === null ? 'depth unknown' : `${p.wethDepth.toFixed(2)} ${CURRENCY_SYMBOL}`}
        </span>
        <span className="sep">·</span>
        <span>{(p.feeTier / 10_000).toFixed(2)}% fee</span>
        <span className="sep">·</span>
        <span>{age(p.ageSec)} old</span>
      </div>

      {p.marketDurations.length > 0 ? (
        <div className="pool-markets">
          {p.marketDurations.map((d) => {
            const market = marketForChip(index, p.pool, d)
            // A chip that only describes a market is a dead end for someone who
            // came here to trade it. When the markets list has the address, the
            // chip is the way in; when it has not (yet), it stays a label.
            return market ? (
              <Link
                key={d}
                to={`/market/${market.address}`}
                className="pool-dur pool-dur-link"
                aria-label={`Trade ${p.symbol ?? 'this pool'} on the ${formatDuration(d)} market`}
              >
                {formatDuration(d)}
                <span className="pool-trade">Trade →</span>
              </Link>
            ) : (
              <span key={d} className="pool-dur">
                {formatDuration(d)}
              </span>
            )
          })}
        </div>
      ) : (
        // The reason is the content of this row when there is nothing to trade,
        // so it is shown rather than summarised.
        <div className="pool-reason">{p.reason ?? 'not looked at yet'}</div>
      )}
    </div>
  )
}

export function Pools() {
  const [filter, setFilter] = useState<PoolStatus | 'ALL'>('ALL')
  const { data, isLoading, isError, refetch, dataUpdatedAt } = usePools(filter === 'ALL' ? undefined : filter)
  const { data: openMarkets } = useMarkets('OPEN')
  const index = useMemo(() => marketIndex(openMarkets), [openMarkets])
  // The pool feed refetches every 30s; the dot goes amber after three misses.
  const freshness = useFreshness({ dataUpdatedAt, isError, hasData: !!data }, 90_000)

  const pools = data?.pools ?? []
  const summary = useMemo(() => {
    const tradable = pools.filter((p) => p.marketDurations.length > 0)
    const depth = tradable.reduce((a, p) => a + (p.wethDepth ?? 0), 0)
    return { tradable: tradable.length, seen: pools.length, depth }
  }, [pools])

  // A chain whose markets come from a price feed has no pools to browse, and
  // saying so is better than an empty list that looks like a failure.
  if (data && !data.poolBacked) {
    return (
      <>
        <ScreenTitle title="Pools" />
        <p className="empty-state">
          This deployment prices its markets from a feed rather than from a pool, so there is no
          pool list. <Link to="/">Markets</Link> is what you want.
        </p>
      </>
    )
  }

  return (
    <>
      <ScreenTitle
        title="Pools"
        live
        liveLabel={freshness.level === 'live' ? 'watching' : freshness.label}
        liveColor={freshness.color}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="#4d8dff" strokeWidth="2" />
            <path d="M3 11c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="#4d8dff" strokeWidth="2" opacity=".5" />
          </svg>
        }
      />

      <StatStrip
        items={[
          { k: 'Tradable', v: summary.tradable },
          { k: 'Seen', v: summary.seen },
          { k: 'Depth', v: summary.depth.toFixed(1), u: CURRENCY_SYMBOL },
        ]}
      />

      <div className="pool-filters">
        {(['ALL', 'ONBOARDED', 'PENDING', 'REJECTED'] as const).map((f) => (
          <button
            key={f}
            className={'pool-filter' + (filter === f ? ' on' : '')}
            onClick={() => setFilter(f)}
          >
            {f === 'ALL' ? 'all' : STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      {isLoading && <p className="empty-state">Reading the chain…</p>}
      {isError && <ApiError message="Couldn't load pools" onRetry={refetch} />}
      {!isLoading && !isError && pools.length === 0 && (
        <p className="empty-state">
          No pools here yet. The watcher scans the Uniswap factory every minute and lists what it
          finds, whether or not it can trade it.
        </p>
      )}

      <div className="pool-list">
        {pools.map((p) => (
          <PoolRow key={p.pool} p={p} index={index} />
        ))}
      </div>

      <p className="pool-note">
        A pool needs depth, a full observation ring and real price history before a market can
        exist on it. Anyone can create one that qualifies; the keeper pays for the deep ones
        itself.
      </p>
    </>
  )
}
