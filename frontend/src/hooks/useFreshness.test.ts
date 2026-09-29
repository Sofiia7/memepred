// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { formatAge, freshnessOf, makeFreshness, worstOf } from './useFreshness'

const NOW = 1_800_000_000_000
const base = { nowMs: NOW, dataUpdatedAt: NOW - 5_000, isError: false, hasData: true, maxAgeMs: 45_000 }

describe('freshnessOf: what the LIVE / WATCHING dot may claim', () => {
  it('live only while recent data is in hand', () => {
    expect(freshnessOf(base)).toMatchObject({ level: 'live', label: 'live', color: 'var(--up)' })
  })

  it('stays live right up to the limit and turns stale just past it', () => {
    expect(freshnessOf({ ...base, dataUpdatedAt: NOW - 45_000 }).level).toBe('live')
    const stale = freshnessOf({ ...base, dataUpdatedAt: NOW - 46_000 })
    expect(stale.level).toBe('stale')
    expect(stale.label).toBe('stale - 46s old')
    expect(stale.color).toBe('var(--warn)')
  })

  it('connecting, not live, before the first answer', () => {
    expect(freshnessOf({ ...base, hasData: false, dataUpdatedAt: 0 })).toMatchObject({
      level: 'loading',
      label: 'connecting',
      color: 'var(--text-faint)',
    })
  })

  it('offline when the latest fetch failed, with or without old data', () => {
    expect(freshnessOf({ ...base, isError: true, hasData: false, dataUpdatedAt: 0 })).toMatchObject({
      level: 'error',
      label: 'offline',
      color: 'var(--down)',
    })
    const withOld = freshnessOf({ ...base, isError: true, dataUpdatedAt: NOW - 120_000 })
    expect(withOld.level).toBe('error')
    expect(withOld.label).toBe('offline - last update 2m ago')
  })

  it('an error beats a fresh timestamp: recent data does not excuse a failing feed', () => {
    expect(freshnessOf({ ...base, isError: true, dataUpdatedAt: NOW - 1_000 }).level).toBe('error')
  })

  it('a clock a hair behind the data is not negative age', () => {
    expect(freshnessOf({ ...base, dataUpdatedAt: NOW + 900 }).level).toBe('live')
  })
})

describe('worstOf', () => {
  const live = makeFreshness('live', 'live')
  const loading = makeFreshness('loading', 'connecting')
  const stale = makeFreshness('stale', 'price stale')
  const error = makeFreshness('error', 'offline')

  it('takes the worse of two sources, with its own wording', () => {
    expect(worstOf(live, stale)).toBe(stale)
    expect(worstOf(stale, live)).toBe(stale)
    expect(worstOf(live, loading)).toBe(loading)
    expect(worstOf(stale, error)).toBe(error)
    expect(worstOf(error, stale)).toBe(error)
  })

  it('keeps the first when they tie', () => {
    expect(worstOf(live, makeFreshness('live', 'other'))).toBe(live)
  })
})

describe('formatAge', () => {
  it('is seconds, then minutes, then hours', () => {
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(45_000)).toBe('45s')
    expect(formatAge(120_000)).toBe('2m')
    expect(formatAge(2 * 3600_000)).toBe('2h')
    expect(formatAge(-5)).toBe('0s')
  })
})
