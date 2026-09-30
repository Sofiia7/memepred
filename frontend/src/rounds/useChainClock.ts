import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { useNow } from '../hooks/useNow'

/**
 * "Now" as the contract will see it, to the second.
 *
 * Every deadline on the rounds screen is a block timestamp, and the one that
 * matters most - the close of bets - decides whether a bet is accepted at all
 * and when the strike starts. A visitor whose computer clock runs a minute slow
 * would otherwise be shown a minute that does not exist.
 *
 * The chain gives no exact clock either: its latest block can be seconds old
 * on a quiet chain, where blocks are only made for transactions. So the clock
 * is the local one, moved forward - never back - by however far the latest
 * block is ahead of it. A slow local clock is corrected; an idle chain does not
 * drag the countdowns into the past. A local clock that runs fast cannot be
 * detected this way; the contract is the final judge of every window and a
 * transaction outside one reverts without moving money.
 */
export function clockOffset(blockTimestamp: number, localSec: number): number {
  const ahead = Math.floor(blockTimestamp - localSec)
  return ahead > 0 ? ahead : 0
}

export function useChainClock(): { now: number; synced: boolean } {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const local = useNow(1000)
  const [offset, setOffset] = useState(0)
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    const sync = async () => {
      try {
        const block = await client.getBlock({ blockTag: 'latest' })
        if (cancelled) return
        setOffset(clockOffset(Number(block.timestamp), Date.now() / 1000))
        setSynced(true)
      } catch {
        // Keep the last offset; the local clock is still a clock.
      }
    }
    void sync()
    const t = setInterval(sync, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [client])

  return { now: local + offset, synced }
}
