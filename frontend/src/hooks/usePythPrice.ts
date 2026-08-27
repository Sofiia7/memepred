import { useEffect, useState } from 'react'

import { fetchDisplayPrice } from '../lib/oracle.js'

export interface PythPrice {
  raw: bigint           // 1e18-normalized for contract calls
  display: number       // human-readable
  loading: boolean
}

export function usePythPrice(feedId?: string | null): PythPrice {
  const [raw, setRaw] = useState<bigint>(0n)
  const [display, setDisplay] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(!!feedId)

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
      } catch {
        /* network blip — keep last */
      } finally {
        if (!cancel) setLoading(false)
      }
    }

    tick()
    timer = setInterval(tick, 10_000)
    return () => { cancel = true; clearInterval(timer) }
  }, [feedId])

  return { raw, display, loading }
}
