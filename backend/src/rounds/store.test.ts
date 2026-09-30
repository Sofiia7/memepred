import { describe, it, expect } from 'vitest'
import { createRedisRoundsStore, ROUNDS_STATE_KEY, ROUNDS_STATE_TTL_SEC, type RedisLike, type RoundsSnapshot } from './store.js'

/** The node-redis calls the store makes, over plain maps. */
class FakeRedis implements RedisLike {
  kv = new Map<string, { value: string; ttl: number | null }>()
  sets = new Map<string, Set<string>>()
  zsets = new Map<string, Array<{ score: number; value: string }>>()

  async get(k: string) { return this.kv.get(k)?.value ?? null }
  async set(k: string, value: string) { this.kv.set(k, { value, ttl: null }) }
  async setEx(k: string, ttl: number, value: string) { this.kv.set(k, { value, ttl }) }
  async sAdd(k: string, m: string[]) { const s = this.sets.get(k) ?? new Set(); m.forEach((x) => s.add(x)); this.sets.set(k, s) }
  async sRem(k: string, m: string[]) { m.forEach((x) => this.sets.get(k)?.delete(x)) }
  async sMembers(k: string) { return [...(this.sets.get(k) ?? [])] }
  async zAdd(k: string, e: { score: number; value: string }) { const z = this.zsets.get(k) ?? []; z.push(e); this.zsets.set(k, z) }
  private inRange(score: number, min: number | string, max: number | string) {
    const lo = min === '-inf' ? -Infinity : Number(min)
    const hi = max === '+inf' ? Infinity : Number(max)
    return score >= lo && score <= hi
  }
  async zRangeByScore(k: string, min: number | string, max: number | string) {
    return (this.zsets.get(k) ?? []).filter((e) => this.inRange(e.score, min, max)).map((e) => e.value)
  }
  async zRemRangeByScore(k: string, min: number | string, max: number | string) {
    this.zsets.set(k, (this.zsets.get(k) ?? []).filter((e) => !this.inRange(e.score, min, max)))
  }
}

const A = '0x00000000000000000000000000000000000000aA' as const
const B = '0x00000000000000000000000000000000000000bB' as const

describe('Redis rounds store', () => {
  it('keeps cursor, open set and spend per contract, so a redeploy starts clean', async () => {
    const redis = new FakeRedis()
    const a = createRedisRoundsStore(redis, A)
    const b = createRedisRoundsStore(redis, B)
    await a.setCursor(123n)
    await a.addOpen([1n, 2n])
    await a.addSpent(1n, 500n)
    expect(await a.getCursor()).toBe(123n)
    expect(await b.getCursor()).toBeNull()
    expect(await b.openRounds()).toEqual([])
    expect(await b.getSpent(1n)).toBe(0n)
    expect([...redis.kv.keys()].every((k) => k.startsWith('rounds:0x00000000000000000000000000000000000000aa:'))).toBe(true)
  })

  it('adds and trues up spend as bigints beyond 64 bits, with a TTL', async () => {
    const redis = new FakeRedis()
    const s = createRedisRoundsStore(redis, A)
    const big = 2n ** 70n
    expect(await s.addSpent(9n, big)).toBe(big)
    expect(await s.addSpent(9n, -big + 5n)).toBe(5n)
    expect(await s.getSpent(9n)).toBe(5n)
    expect(redis.kv.get('rounds:0x00000000000000000000000000000000000000aa:spent:9')?.ttl).toBeGreaterThan(0)
  })

  it('removes rounds from the open set', async () => {
    const s = createRedisRoundsStore(new FakeRedis(), A)
    await s.addOpen([1n, 2n, 3n])
    await s.removeOpen([2n])
    expect(new Set(await s.openRounds())).toEqual(new Set([1n, 3n]))
    await s.addOpen([])
    await s.removeOpen([])
  })

  it('sums the last 24 h of receipts and forgets what is two days old', async () => {
    const redis = new FakeRedis()
    const s = createRedisRoundsStore(redis, A)
    const H = 3600_000
    await s.logSpend(0, 1_000n, 'settle:0xold')
    await s.logSpend(30 * H, 20n, 'settle:0xa')
    await s.logSpend(49 * H, 300n, 'fixStrike:0xb')
    expect(await s.spentSince(49 * H - 24 * H)).toBe(320n)
    // The first one was trimmed when the last was logged (older than 48 h).
    expect(await s.spentSince(0)).toBe(320n)
  })

  it('keeps listed pools and a per-day spend, namespaced like the rest', async () => {
    const redis = new FakeRedis()
    const s = createRedisRoundsStore(redis, A)
    await s.addPools(['0x00000000000000000000000000000000000000Ab'])
    expect(await s.listedPools()).toEqual(['0x00000000000000000000000000000000000000AB'])
    await s.removePools(['0x00000000000000000000000000000000000000ab'])
    expect(await s.listedPools()).toEqual([])
    expect(await s.addDaySpent('delist', '2026-09-30', 70n)).toBe(70n)
    expect(await s.addDaySpent('delist', '2026-09-30', -20n)).toBe(50n)
    expect(await s.getDaySpent('delist', '2026-10-01')).toBe(0n)
    expect(await createRedisRoundsStore(redis, B).getDaySpent('delist', '2026-09-30')).toBe(0n)
  })

  it('publishes the snapshot under one global key with a TTL', async () => {
    const redis = new FakeRedis()
    const s = createRedisRoundsStore(redis, A)
    await s.publish({ version: 1, lastTick: 1 } as RoundsSnapshot)
    expect(redis.kv.get(ROUNDS_STATE_KEY)).toEqual({ value: JSON.stringify({ version: 1, lastTick: 1 }), ttl: ROUNDS_STATE_TTL_SEC })
  })
})
