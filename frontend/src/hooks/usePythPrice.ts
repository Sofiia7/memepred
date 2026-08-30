import { useEffect, useState } from 'react'

import { fetchDisplayPrice } from '../lib/oracle.js'

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
        // RedStone hands back a plain number, so there is no exponent to
        // apply - only the scaling to the 1e18 the contracts work in.
        const usd = await fetchDisplayPrice(feedId!)
        if (cancel) return
        setRaw(BigInt(Math.round(usd * 1e18)))
        setDisplay(usd)
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
  }, [feedId])

  // Ticks the clock so staleness appears on its own, without waiting for a
  // successful fetch to re-render the component that is displaying nothing new.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])

  const stale = lastOkAt > 0 && now - lastOkAt > PRICE_STALE_AFTER_MS

  return { raw, display, loading, stale }
}
