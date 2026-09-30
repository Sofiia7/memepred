import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { POOL_ROUNDS_ABI, readRoundsConfig, DEFAULT_ROUND_DURATIONS } from './roundsAbi'

// vitest runs from frontend/ (package.json scripts), so the artifact is one level up.
const ARTIFACT = resolve(process.cwd(), '../contracts/out/PoolRounds.sol/PoolRounds.json')

type Item = { type: string; name?: string; inputs?: readonly { type: string }[]; outputs?: readonly { type: string }[] }
const sig = (e: Item) => `${e.type} ${e.name}(${(e.inputs ?? []).map((i) => i.type).join(',')})->(${(e.outputs ?? []).map((o) => o.type).join(',')})`

function builtAbi(): Item[] | undefined {
  if (!existsSync(ARTIFACT)) return undefined
  return JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi as Item[]
}
const built = builtAbi()
// The current contract has bet(); a build of an older version without it has
// nothing to compare with, and the check is skipped rather than failed.
const redesignBuilt = !!built?.some((e) => e.type === 'function' && e.name === 'bet')

describe('POOL_ROUNDS_ABI', () => {
  it.skipIf(!redesignBuilt)('matches the built PoolRounds for every function and event the screen uses', () => {
    const have = new Set((built ?? []).map(sig))
    const used = (POOL_ROUNDS_ABI as readonly Item[]).filter((e) => e.type === 'function' || e.type === 'event')
    const missing = used.map(sig).filter((s) => !have.has(s))
    expect(missing).toEqual([])
  })

  it('has the calls and events the adapter relies on', () => {
    const names = new Set((POOL_ROUNDS_ABI as readonly Item[]).map((e) => e.name))
    for (const n of ['bet', 'claim', 'ticketOf', 'roundTimes', 'roundView', 'previewClaim', 'minStake', 'maxStake', 'maxSideRatio', 'costAllowance', 'strikePause', 'strikeWindow', 'Bet', 'Claimed', 'PoolListed', 'DurationSet']) {
      expect(names.has(n)).toBe(true)
    }
  })

  it('bets in the open: bet(roundId, stake, side, referrer) and Bet(roundId, player, side, stake)', () => {
    const items = POOL_ROUNDS_ABI as readonly Item[]
    expect(sig(items.find((e) => e.name === 'bet') as Item)).toBe('function bet(uint256,uint256,uint8,address)->()')
    expect(sig(items.find((e) => e.name === 'Bet') as Item)).toBe('event Bet(uint256,address,uint8,uint256)->()')
    expect(items.some((e) => e.name === 'commit' || e.name === 'reveal')).toBe(false)
  })
})

describe('readRoundsConfig', () => {
  const ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

  it('is off by default, and off for anything but exactly "1"', () => {
    expect(readRoundsConfig({}).enabled).toBe(false)
    for (const v of ['0', 'true', ' 1', '1 ', '﻿1', 'yes']) expect(readRoundsConfig({ VITE_ROUNDS_ENABLED: v }).enabled).toBe(false)
    expect(readRoundsConfig({ VITE_ROUNDS_ENABLED: '1', VITE_POOL_ROUNDS_ADDRESS: ADDR }).enabled).toBe(true)
  })

  it('needs an address only when on, and checksums it', () => {
    expect(readRoundsConfig({}).problems).toEqual([])
    expect(readRoundsConfig({ VITE_ROUNDS_ENABLED: '1' }).problems[0]).toMatch(/VITE_POOL_ROUNDS_ADDRESS/)
    expect(readRoundsConfig({ VITE_ROUNDS_ENABLED: '1', VITE_POOL_ROUNDS_ADDRESS: '0x' + '0'.repeat(40) }).problems.length).toBe(1)
    expect(readRoundsConfig({ VITE_ROUNDS_ENABLED: '1', VITE_POOL_ROUNDS_ADDRESS: ADDR.toLowerCase() }).address).toBe(ADDR)
  })

  it('reads the deploy block and the candidate durations, and refuses nonsense', () => {
    const ok = readRoundsConfig({ VITE_ROUNDS_ENABLED: '1', VITE_POOL_ROUNDS_ADDRESS: ADDR, VITE_ROUNDS_DEPLOY_BLOCK: '1234', VITE_ROUNDS_DURATIONS: '900, 300,300' })
    expect(ok.deployBlock).toBe(1234n)
    expect(ok.durations).toEqual([300, 900])
    expect(ok.problems).toEqual([])
    expect(readRoundsConfig({}).durations).toEqual(DEFAULT_ROUND_DURATIONS)
    expect(readRoundsConfig({ VITE_ROUNDS_DEPLOY_BLOCK: '-1' }).problems.length).toBe(1)
    expect(readRoundsConfig({ VITE_ROUNDS_DURATIONS: '5m' }).problems.length).toBe(1)
  })
})
