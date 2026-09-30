/**
 * Which rounds and pools exist, from the contract's own events.
 *
 * Rounds are never created: a round is (pool, duration, window) and appears in
 * storage with its first bet, so the only way to know which ones exist is to
 * read what the contract said. Which events say so is contract.ts's list
 * (DISCOVERY_EVENTS, CLOSING_EVENTS), not this file's: RoundOpened is the
 * obvious signal, but any event naming a round counts, because a first run that
 * starts after a round's RoundOpened (a lookback that did not reach it) still
 * sees its later events. RoundSettled takes a round out, and its outcome and
 * reason are passed on so health can count refunds by name.
 *
 * Pools: PoolListed puts one in, PoolDelisted (which delistIfBelowGate emits
 * too) takes it out; a round's pool is put in as well, since a round only
 * opens on a listed pool. The keeper's gate check asks the contract about each
 * of them and drops the ones that answer PoolNotListed.
 *
 * Only membership comes from here. Whether a round is activated, fixed or
 * settled is read from roundView every time it matters: events are for finding
 * rounds, the state is for deciding.
 *
 * Ranges: 100 000 blocks per getLogs, which the public RHC RPC serves (the same
 * figure as poolWatcher.ts). The cursor is a block number in the store; each
 * tick re-reads `overlap` blocks behind it, because a load-balanced RPC can
 * answer a range from a replica that is a block or two short of its end
 * (project memory: base-public-rpc-serves-stale-reads). Every event is handled
 * as set membership, so reading one twice changes nothing.
 */
import type { Address } from 'viem'
import type { ContractLog } from './chain.js'
import { CLOSING_EVENTS, decodeRoundId } from './contract.js'
import type { RoundsStore } from './store.js'

export interface DiscoveryOptions {
  chunk: bigint
  overlap: bigint
  lookback: bigint
  startBlock: bigint | null
  maxChunks: number
  confirmations: bigint
}

export interface DiscoveryResult {
  fromBlock: bigint | null
  toBlock: bigint | null
  head: bigint
  chunks: number
  added: number
  removed: number
  /** RoundSettled seen in the ranges read (possibly again, over the overlap). */
  settled: Array<{ roundId: bigint; outcome: number; reason: number }>
  /** The cursor reached the (confirmed) head. */
  caughtUp: boolean
}

const order = (a: ContractLog, b: ContractLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

export async function discoverRounds(
  src: { logs(from: bigint, to: bigint): Promise<ContractLog[]> },
  head: bigint,
  store: RoundsStore,
  opts: DiscoveryOptions,
  /** Rounds this process already finished with: a re-read event must not bring them back. */
  forgotten: ReadonlySet<bigint> = new Set(),
): Promise<DiscoveryResult> {
  const safeHead = head > opts.confirmations ? head - opts.confirmations : 0n
  const cursor = await store.getCursor()

  let from: bigint
  if (cursor === null) {
    from = opts.startBlock ?? (safeHead > opts.lookback ? safeHead - opts.lookback : 0n)
  } else {
    const back = cursor + 1n - opts.overlap
    from = back > 0n ? back : 0n
  }
  if (opts.startBlock !== null && from < opts.startBlock) from = opts.startBlock

  const res: DiscoveryResult = { fromBlock: null, toBlock: null, head, chunks: 0, added: 0, removed: 0, settled: [], caughtUp: false }
  if (from > safeHead) {
    res.caughtUp = true
    return res
  }
  res.fromBlock = from

  while (from <= safeHead && res.chunks < opts.maxChunks) {
    const to = from + opts.chunk - 1n < safeHead ? from + opts.chunk - 1n : safeHead
    const logs = await src.logs(from, to)
    res.chunks++

    // In chain order, so a round opened and settled inside one range ends up
    // out, and a pool listed then delisted ends up delisted.
    logs.sort(order)
    const rounds = new Map<bigint, boolean>()
    const pools = new Map<string, { pool: Address; listed: boolean }>()
    for (const l of logs) {
      if (l.kind === 'pool') {
        pools.set(l.pool.toLowerCase(), { pool: l.pool, listed: l.eventName === 'PoolListed' })
        continue
      }
      const closing = CLOSING_EVENTS.includes(l.eventName)
      rounds.set(l.roundId, !closing)
      if (closing && l.outcome !== undefined) res.settled.push({ roundId: l.roundId, outcome: l.outcome, reason: l.reason ?? 0 })
      if (l.eventName === 'RoundOpened') {
        const pool = decodeRoundId(l.roundId).pool
        if (!pools.has(pool.toLowerCase())) pools.set(pool.toLowerCase(), { pool, listed: true })
      }
    }

    const add: bigint[] = []
    const remove: bigint[] = []
    for (const [id, open] of rounds) {
      if (open && !forgotten.has(id)) add.push(id)
      else if (!open) remove.push(id)
    }
    await store.addOpen(add)
    await store.removeOpen(remove)
    await store.addPools([...pools.values()].filter((p) => p.listed).map((p) => p.pool))
    await store.removePools([...pools.values()].filter((p) => !p.listed).map((p) => p.pool))
    res.added += add.length
    res.removed += remove.length

    // Never move the cursor backwards: the overlap re-reads, it does not rewind.
    if (cursor === null || to > cursor) await store.setCursor(to)
    res.toBlock = to
    from = to + 1n
  }
  res.caughtUp = from > safeHead
  return res
}
