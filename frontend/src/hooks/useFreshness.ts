import { useNow } from './useNow'

/**
 * How current the data on a screen is, for the LIVE / WATCHING dot.
 *
 * The dot used to be a constant: Markets and Pools lit it whatever the API was
 * doing, so a dead backend still read "live" over a board that had stopped
 * moving. This turns react-query's own bookkeeping (when the data last arrived,
 * whether the last fetch failed) into one of four honest states.
 */
export type FreshnessLevel = 'live' | 'loading' | 'stale' | 'error'

export interface Freshness {
  level: FreshnessLevel
  /** Short, lowercase, for the ScreenTitle label. */
  label: string
  /** A CSS colour for the dot. */
  color: string
}

const COLOR: Record<FreshnessLevel, string> = {
  live:    'var(--up)',
  loading: 'var(--text-faint)',
  stale:   'var(--warn)',
  error:   'var(--down)',
}

/** Worse states win when two sources are combined. */
const SEVERITY: Record<FreshnessLevel, number> = { live: 0, loading: 1, stale: 2, error: 3 }

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export interface FreshnessInput {
  nowMs: number
  /** react-query's dataUpdatedAt: ms since epoch, 0 before any data. */
  dataUpdatedAt: number
  /** The latest fetch failed (react-query keeps the last good data alongside). */
  isError: boolean
  hasData: boolean
  /** Older than this and the data is called stale. A few refetch intervals. */
  maxAgeMs: number
}

/** A Freshness for a source that already knows its own level (e.g. a price's own `stale` flag). */
export function makeFreshness(level: FreshnessLevel, label: string): Freshness {
  return { level, label, color: COLOR[level] }
}

export function freshnessOf({ nowMs, dataUpdatedAt, isError, hasData, maxAgeMs }: FreshnessInput): Freshness {
  const make = makeFreshness

  if (isError) return make('error', hasData ? `offline - last update ${formatAge(nowMs - dataUpdatedAt)} ago` : 'offline')
  if (!hasData) return make('loading', 'connecting')

  const age = Math.max(0, nowMs - dataUpdatedAt)
  if (age > maxAgeMs) return make('stale', `stale - ${formatAge(age)} old`)
  return make('live', 'live')
}

/** The worse of two states, with its own wording. */
export function worstOf(a: Freshness, b: Freshness): Freshness {
  return SEVERITY[b.level] > SEVERITY[a.level] ? b : a
}

/** Re-evaluates every 5 seconds, so a feed that goes quiet turns stale on its own. */
export function useFreshness(
  input: Omit<FreshnessInput, 'nowMs' | 'maxAgeMs'>,
  maxAgeMs: number,
): Freshness {
  const nowSec = useNow(5000)
  return freshnessOf({ ...input, nowMs: nowSec * 1000, maxAgeMs })
}
