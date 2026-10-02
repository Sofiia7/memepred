import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { signedTick, type TickSample } from './strikeMath'

/**
 * The pool's current tick, read from slot0() every few seconds while a bet is
 * on screen, kept in memory for the session so every ticket of the same pool
 * shares one series and one poll. No backend: the stand-in pools of the
 * testnet have no price history anywhere else, and on a real chain this is
 * the same number the contract settles on. The line starts when the page
 * opens; it does not reach back before that.
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
  const key = pool?.toLowerCase() ?? ''
  const [, bump] = useState(0)
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
    if (q.data === undefined || wethIsToken0 === undefined || !key) return
    append(key, { t: now, tick: signedTick(q.data, wethIsToken0) })
    // `now` moves every second; a sample is taken when the read lands, not on every clock tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, q.dataUpdatedAt, key, wethIsToken0])
  return useMemo(() => [...(series.get(key) ?? [])], [key, q.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
}
