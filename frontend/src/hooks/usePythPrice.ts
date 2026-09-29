import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'

import { fetchDisplayPrice } from '../lib/oracle.js'
import { CONTRACTS, IS_POOL_BACKED, POOL_ORACLE_RESOLVER_ABI } from '../lib/contracts.js'

/**
 * How long a price may go unrefreshed before the UI stops calling it live.
 *
 * The poll runs every 10s, so three missed rounds. A failing fetch keeps the
 * last value on screen, which is the right call - a blanked-out price is worse
 * than a slightly old one - but it used to do so silently while the market page
 * kept a "live" chip lit next to it. A frozen number labelled live is a claim
 * the app cannot support.
 */
export const PRICE_STALE_AFTER_MS = 35_000

/** How often the price is re-read while a feed is being watched. */
const POLL_MS = 10_000

/**
 * Where a price is, as a single word, so a caller can gate on it instead of
 * combining flags:
 *
 *   idle         there is no feed to price (none picked, or its id not known yet)
 *   loading      a feed is being read and nothing has answered yet
 *   unavailable  the feed never produced a usable price (every read failed, or
 *                came back as zero)
 *   stale        there is a price, but it has not been refreshed recently
 *   live         a price no older than PRICE_STALE_AFTER_MS
 *
 * Only `live` is safe to sign a bet against.
 */
export type PriceStatus = 'idle' | 'loading' | 'unavailable' | 'stale' | 'live'

export interface PythPrice {
  raw: bigint           // 1e18-normalized for contract calls; 0n unless status is stale or live
  display: number       // human-readable
  /** A feed is being read and nothing has answered yet. */
  loading: boolean
  /** The displayed price has not refreshed recently; show it as such. */
  stale: boolean
  /** The feed has never produced a usable price. Distinct from loading: this is a failure. */
  unavailable: boolean
  status: PriceStatus
}

/**
 * What the last reads of one feed said. Keyed by the feed it belongs to, so a
 * reading is never attributed to a different feed than the one asked about:
 * when feedId changes, the previous feed's price is simply not this feed's
 * reading, with no window in which it could be shown or signed against.
 */
interface Reading {
  feedId: string
  raw: bigint
  /** When `raw` was last read successfully; 0 if it never was. */
  lastOkAt: number
  /** At least one read of this feed has finished, whether or not it worked. */
  attempted: boolean
}

export function usePythPrice(feedId?: string | null): PythPrice {
  const publicClient = usePublicClient()
  const [reading, setReading] = useState<Reading | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!feedId) return
    // Robinhood markets read the pool through the resolver's client. Until
    // there is one there is nothing to ask, which is "still loading", not a
    // failure.
    if (IS_POOL_BACKED && !publicClient) return

    let cancelled = false
    let inFlight = false

    async function tick() {
      // A slow read must not stack a second one behind it.
      if (inFlight) return
      inFlight = true
      try {
        // Robinhood markets price directly from their Uniswap v3 pool. The
        // same resolver call supplies the displayed strike and the contract's
        // entry check, so the UI never asks the legacy RedStone API to decode
        // a pool address as a symbol.
        const rawPrice = IS_POOL_BACKED
          ? await publicClient!.readContract({
              address: CONTRACTS.ORACLE_RESOLVER,
              abi: POOL_ORACLE_RESOLVER_ABI,
              functionName: 'spotPriceWad',
              args: [feedId as `0x${string}`],
            })
          : BigInt(Math.round((await fetchDisplayPrice(feedId!)) * 1e18))
        if (cancelled) return
        // Zero is not a price. It would sail through a "loaded" check and be
        // signed as expectedPrice, which the contract rejects after the user
        // has already paid for an approval.
        if (rawPrice <= 0n) throw new Error('price feed returned zero')
        setReading({ feedId: feedId as string, raw: rawPrice, lastOkAt: Date.now(), attempted: true })
      } catch {
        if (cancelled) return
        /* network blip - keep the last price for this feed, but stop calling it live */
        setReading((prev) =>
          prev && prev.feedId === feedId
            ? { ...prev, attempted: true }
            : { feedId: feedId as string, raw: 0n, lastOkAt: 0, attempted: true },
        )
      } finally {
        inFlight = false
      }
    }

    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [feedId, publicClient])

  // Ticks the clock so staleness appears on its own, without waiting for a
  // successful fetch to re-render the component that is displaying nothing new.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])

  const cur = feedId && reading && reading.feedId === feedId ? reading : null
  const hasPrice = !!cur && cur.lastOkAt > 0 && cur.raw > 0n

  const raw = hasPrice ? cur!.raw : 0n
  const display = Number(raw) / 1e18
  const loading = !!feedId && (!cur || !cur.attempted)
  const unavailable = !!feedId && !!cur && cur.attempted && !hasPrice
  const stale = hasPrice && now - cur!.lastOkAt > PRICE_STALE_AFTER_MS

  const status: PriceStatus = !feedId
    ? 'idle'
    : loading
      ? 'loading'
      : unavailable
        ? 'unavailable'
        : stale
          ? 'stale'
          : 'live'

  return { raw, display, loading, stale, unavailable, status }
}
