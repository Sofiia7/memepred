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

export interface PythPrice {
  raw: bigint           // 1e18-normalized for contract calls
  display: number       // human-readable
  loading: boolean
  /** The displayed price has not refreshed recently; show it as such. */
  stale: boolean
}

export function usePythPrice(feedId?: string | null): PythPrice {
  const publicClient = usePublicClient()
  const [raw, setRaw] = useState<bigint>(0n)
  const [display, setDisplay] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(!!feedId)
  const [lastOkAt, setLastOkAt] = useState<number>(0)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!feedId) { setLoading(false); return }
    let cancel = false
    let timer: any

    async function tick() {
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
        if (cancel) return
        setRaw(rawPrice)
        setDisplay(Number(rawPrice) / 1e18)
        setLastOkAt(Date.now())
      } catch {
        /* network blip - keep the last price, but stop calling it live */
      } finally {
        if (!cancel) setLoading(false)
      }
    }

    tick()
    timer = setInterval(tick, 10_000)
    return () => { cancel = true; clearInterval(timer) }
  }, [feedId, publicClient])

  // Ticks the clock so staleness appears on its own, without waiting for a
  // successful fetch to re-render the component that is displaying nothing new.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])

  const stale = lastOkAt > 0 && now - lastOkAt > PRICE_STALE_AFTER_MS

  return { raw, display, loading, stale }
}
