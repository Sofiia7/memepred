import { useEffect, useState } from 'react'

const HERMES = import.meta.env.VITE_PYTH_HERMES ?? import.meta.env.VITE_PYTH_HERMES_URL ?? 'https://hermes.pyth.network'

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
        const id = feedId!.startsWith('0x') ? feedId!.slice(2) : feedId!
        const r = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`)
        if (!r.ok) throw new Error('hermes ' + r.status)
        const j = await r.json() as any
        const p = j.parsed?.[0]?.price
        if (!p || cancel) return
        const price = BigInt(p.price)
        const expo = Number(p.expo)
        const wei = expo < 0
          ? (price * 10n ** 18n) / (10n ** BigInt(-expo))
          : (price * 10n ** 18n) * (10n ** BigInt(expo))
        setRaw(wei)
        setDisplay(Number(p.price) * Math.pow(10, expo))
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
