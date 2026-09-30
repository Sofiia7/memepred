import { describe, it, expect } from 'vitest'
import { discoverRounds, type DiscoveryOptions } from './discovery.js'
import { MemoryRoundsStore } from './store.js'
import type { ContractLog, RoundLog } from './chain.js'
import type { DiscoveryEventName } from './contract.js'

/** getLogs over a scripted list of events, counting calls and recording ranges. */
class Logs {
  events: ContractLog[] = []
  calls: Array<[bigint, bigint]> = []
  add(block: number, eventName: DiscoveryEventName, roundId: bigint, logIndex = 0, extra: Partial<RoundLog> = {}) {
    this.events.push({ eventName, roundId, blockNumber: BigInt(block), logIndex, ...extra })
  }
  pool(block: number, eventName: 'PoolListed' | 'PoolDelisted', pool: `0x${string}`, logIndex = 0) {
    this.events.push({ kind: 'pool', eventName, pool, blockNumber: BigInt(block), logIndex })
  }
  async logs(from: bigint, to: bigint) {
    this.calls.push([from, to])
    // Returned out of order on purpose: discovery must sort.
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to).reverse()
  }
}

const OPTS: DiscoveryOptions = { chunk: 100n, overlap: 5n, lookback: 1_000n, startBlock: null, maxChunks: 20, confirmations: 0n }

describe('discovery', () => {
  it('adds a round on any of its events and removes it on RoundSettled', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    logs.add(10, 'RoundOpened', 1n)
    logs.add(10, 'Bet', 1n, 1)
    logs.add(20, 'Bet', 2n) // opened before the scan began: still found
    logs.add(30, 'Bet', 3n)
    logs.add(40, 'RoundSettled', 3n)
    const r = await discoverRounds(logs, 50n, store, { ...OPTS, startBlock: 0n })
    expect(new Set(await store.openRounds())).toEqual(new Set([1n, 2n]))
    expect(r).toMatchObject({ fromBlock: 0n, toBlock: 50n, caughtUp: true, chunks: 1 })
    expect(store.cursor).toBe(50n)
  })

  it('walks in chunks, never past the head, and resumes from the cursor minus the overlap', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    await discoverRounds(logs, 250n, store, { ...OPTS, startBlock: 0n })
    expect(logs.calls).toEqual([[0n, 99n], [100n, 199n], [200n, 250n]])

    logs.calls = []
    logs.add(248, 'RoundOpened', 7n) // landed late on a lagging replica: the overlap reads it again
    await discoverRounds(logs, 260n, store, OPTS)
    expect(logs.calls).toEqual([[246n, 260n]])
    expect(await store.openRounds()).toEqual([7n])
  })

  it('is idempotent over the overlap: a re-read settles nothing twice and opens nothing settled', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    logs.add(95, 'RoundOpened', 1n)
    logs.add(98, 'RoundSettled', 1n)
    logs.add(99, 'RoundOpened', 2n)
    await discoverRounds(logs, 100n, store, { ...OPTS, startBlock: 0n })
    await discoverRounds(logs, 100n, store, OPTS)
    await discoverRounds(logs, 101n, store, OPTS)
    expect(await store.openRounds()).toEqual([2n])
    expect(store.cursor).toBe(101n)
  })

  it('passes on who settled with which outcome and reason, for health', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    logs.add(10, 'RoundOpened', 1n)
    logs.add(20, 'RoundSettled', 1n, 0, { outcome: 4, reason: 4 })
    const r = await discoverRounds(logs, 30n, store, { ...OPTS, startBlock: 0n })
    expect(r.settled).toEqual([{ roundId: 1n, outcome: 4, reason: 4 }])
  })

  it('keeps the set of listed pools from PoolListed, PoolDelisted and the rounds themselves', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    const A = '0x1111111111111111111111111111111111111111'
    const B = '0x2222222222222222222222222222222222222222'
    logs.pool(5, 'PoolListed', A)
    logs.pool(6, 'PoolListed', B)
    logs.pool(9, 'PoolDelisted', B) // delistIfBelowGate emits it too
    // A round on a pool whose listing predates the scan still names the pool.
    const C = '0x3333333333333333333333333333333333333333'
    logs.add(12, 'RoundOpened', (BigInt(C) << 96n) | (300n << 64n) | 7n)
    await discoverRounds(logs, 20n, store, { ...OPTS, startBlock: 0n })
    expect(new Set((await store.listedPools()).map((p) => p.toLowerCase()))).toEqual(new Set([A, C]))
  })

  it('does not bring back a round this process has finished with', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    logs.add(10, 'Bet', 5n)
    await discoverRounds(logs, 20n, store, { ...OPTS, startBlock: 0n }, new Set([5n]))
    expect(await store.openRounds()).toEqual([])
  })

  it('starts at ROUNDS_START_BLOCK on a first run, else a lookback from the head', async () => {
    const a = new Logs()
    await discoverRounds(a, 5_000n, new MemoryRoundsStore(), { ...OPTS, startBlock: 4_950n })
    expect(a.calls[0][0]).toBe(4_950n)

    const b = new Logs()
    await discoverRounds(b, 5_000n, new MemoryRoundsStore(), OPTS)
    expect(b.calls[0][0]).toBe(4_000n)

    // The overlap never reaches below the deployment block.
    const c = new Logs()
    const store = new MemoryRoundsStore()
    store.cursor = 4_951n
    await discoverRounds(c, 5_000n, store, { ...OPTS, startBlock: 4_950n })
    expect(c.calls[0][0]).toBe(4_950n)
  })

  it('stops at maxChunks per tick, says it is behind, and carries on next tick', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    const r1 = await discoverRounds(logs, 1_000n, store, { ...OPTS, startBlock: 0n, maxChunks: 3 })
    expect(r1.caughtUp).toBe(false)
    expect(store.cursor).toBe(299n)
    const r2 = await discoverRounds(logs, 1_000n, store, { ...OPTS, overlap: 0n, maxChunks: 50 })
    expect(r2.caughtUp).toBe(true)
    expect(logs.calls[3]).toEqual([300n, 399n])
    expect(store.cursor).toBe(1_000n)
  })

  it('stays the confirmations behind the head and never moves the cursor backwards', async () => {
    const logs = new Logs()
    const store = new MemoryRoundsStore()
    logs.add(98, 'RoundOpened', 1n)
    await discoverRounds(logs, 100n, store, { ...OPTS, startBlock: 0n, confirmations: 3n })
    expect(store.cursor).toBe(97n)
    expect(await store.openRounds()).toEqual([])
    await discoverRounds(logs, 101n, store, { ...OPTS, confirmations: 3n })
    expect(await store.openRounds()).toEqual([1n])

    // A head that went backwards (another replica): nothing is read, nothing rewinds.
    logs.calls = []
    const r = await discoverRounds(logs, 50n, store, OPTS)
    expect(r.caughtUp).toBe(true)
    expect(logs.calls).toEqual([])
    expect(store.cursor).toBe(98n)
  })
})
