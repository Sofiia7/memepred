import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { signedTick, type TickSample } from './strikeMath'
import { mergePoolSamples, oracleSamples } from './poolHistory'

/**
 * The pool's current tick, read from slot0() every few seconds while a bet is
 * on screen, kept in memory for the session so every ticket of the same pool
 * shares one series and one poll. Recent interval averages are loaded from
 * observe() so reloading does not erase the chart. Both sources are the
 * actual pool oracle; there is no decorative or random client-side price.
 */
const SLOT0_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint160', name: 'sqrtPriceX96' },
      { type: 'int24', name: 'tick' },
      { type: 'uint16', name: 'observationIndex' },
      { type: 'uint16', name: 'observationCardinality' },
      { type: 'uint16', name: 'observationCardinalityNext' },
      { type: 'uint8', name: 'feeProtocol' },
      { type: 'bool', name: 'unlocked' },
    ],
  },
] as const

const OBSERVE_ABI = [{
  type: 'function', name: 'observe', stateMutability: 'view',
  inputs: [{ type: 'uint32[]' }],
  outputs: [{ type: 'int56[]' }, { type: 'uint160[]' }],
}] as const

export const TICK_POLL_MS = 5_000
const KEEP_SEC = 45 * 60

const series = new Map<string, TickSample[]>()
const listeners = new Set<() => void>()
function append(pool: string, s: TickSample) {
  const list = series.get(pool) ?? []
  const last = list[list.length - 1]
  if (last && last.t >= s.t) return
  list.push(s)
  while (list.length && list[0].t < s.t - KEEP_SEC) list.shift()
  series.set(pool, list)
  for (const l of listeners) l()
}

export function usePoolTicks(pool: Address | undefined, wethIsToken0: boolean | undefined, now: number): TickSample[] {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as PublicClient | undefined
  const key = `${TARGET_CHAIN_ID}:${pool?.toLowerCase() ?? ''}:${wethIsToken0}`
  const [version, bump] = useState(0)
  const history = useQuery({
    queryKey: ['rounds', 'tick-history', key],
    enabled: !!client && !!pool && wethIsToken0 !== undefined,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const block = await (client as PublicClient).getBlock()
      // A young pool may not have ten minutes yet: try a shorter real window.
      for (const window of [600, 120, 60]) {
        const ago = Array.from({ length: window / 20 + 1 }, (_, i) => window - i * 20)
        try {
          const [cumulative] = await (client as PublicClient).readContract({
            address: pool as Address, abi: OBSERVE_ABI, functionName: 'observe', args: [ago], blockNumber: block.number,
          })
          return oracleSamples(ago, cumulative, Number(block.timestamp), wethIsToken0 as boolean)
        } catch { /* Keep the spot series if the pool cannot supply historical observations. */ }
      }
      return []
    },
  })
  const q = useQuery({
    queryKey: ['rounds', 'tick', key],
    enabled: !!client && !!pool && wethIsToken0 !== undefined,
    refetchInterval: TICK_POLL_MS,
    staleTime: TICK_POLL_MS - 500,
    queryFn: async () => {
      const r = await (client as PublicClient).readContract({ address: pool as Address, abi: SLOT0_ABI, functionName: 'slot0' })
      return Number(r[1])
    },
  })
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  useEffect(() => {
    if (!history.data?.length) return
    const merged = mergePoolSamples(history.data, series.get(key) ?? [], now - KEEP_SEC)
    series.set(key, merged)
    for (const l of listeners) l()
    // Merge on a new oracle read, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.dataUpdatedAt, key])
  useEffect(() => {
    if (q.data === undefined || wethIsToken0 === undefined || !key) return
    append(key, { t: now, tick: signedTick(q.data, wethIsToken0) })
    // `now` moves every second; a sample is taken when the read lands, not on every clock tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, q.dataUpdatedAt, key, wethIsToken0])
  return useMemo(() => [...(series.get(key) ?? [])], [key, version])
}
