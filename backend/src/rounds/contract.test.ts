import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { decodeFunctionResult, encodeFunctionResult, getAddress } from 'viem'
import {
  POOL_ROUNDS_ABI,
  DISCOVERY_EVENTS,
  POOL_EVENTS,
  checkDeadlines,
  checkRoundTimes,
  checkRoundView,
  decodeRoundId,
  reasonName,
  roundIdOf,
  roundsDeploymentFromEnv,
  timesFromContract,
  RoundsAbiMismatchError,
  type RawRoundView,
  type RawTimes,
} from './contract.js'

const POOL = getAddress('0x5b0e7a1d2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b')

describe('round id', () => {
  it('is pool << 96 | duration << 64 | index, as PoolRounds.roundIdOf', () => {
    const id = roundIdOf(POOL, 300, 5_966_666)
    expect(id).toBe((BigInt(POOL) << 96n) | (300n << 64n) | 5_966_666n)
    expect(decodeRoundId(id)).toEqual({ pool: POOL, duration: 300n, index: 5_966_666n })
  })

  it('keeps each field in its own bit range at the extremes', () => {
    const max = getAddress('0xffffffffffffffffffffffffffffffffffffffff')
    const id = roundIdOf(max, 2n ** 32n - 1n, 2n ** 64n - 1n)
    expect(id).toBe(2n ** 256n - 1n)
    expect(decodeRoundId(id)).toEqual({ pool: max, duration: 2n ** 32n - 1n, index: 2n ** 64n - 1n })
    expect(() => roundIdOf(POOL, 2n ** 32n, 0)).toThrow(RangeError)
    expect(() => roundIdOf(POOL, 300, 2n ** 64n)).toThrow(RangeError)
  })
})

/**
 * Deadlines are the contract's, never the keeper's: whatever roundTimes says is
 * what the keeper plans on. Here the deployment defaults of v3 (300 s round,
 * 300 s pause, 300 s strike window), written out as the contract reports them.
 */
const RAW_TIMES: RawTimes = {
  openAt: 1_789_999_800n,
  closeAt: 1_790_000_100n,
  strikeStart: 1_790_000_400n,
  strikeEnd: 1_790_000_700n,
  settleAt: 1_790_001_000n,
}

describe('deadlines from the contract', () => {
  it("maps the contract's Times onto the keeper's", () => {
    expect(timesFromContract(RAW_TIMES)).toEqual({
      openAt: 1_789_999_800,
      closeAt: 1_790_000_100,
      strikeStart: 1_790_000_400,
      strikeEnd: 1_790_000_700,
      settleAt: 1_790_001_000,
    })
  })

  it("refuses deadlines that cannot be a round's: out of order, empty windows, not timestamps", () => {
    expect(() => checkRoundTimes(1n, { ...RAW_TIMES, strikeEnd: RAW_TIMES.strikeStart - 1n })).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundTimes(1n, { ...RAW_TIMES, closeAt: RAW_TIMES.openAt })).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundTimes(1n, { ...RAW_TIMES, strikeEnd: RAW_TIMES.strikeStart })).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundTimes(1n, { ...RAW_TIMES, settleAt: RAW_TIMES.strikeEnd })).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundTimes(1n, { ...RAW_TIMES, settleAt: 2n ** 200n })).toThrow(RoundsAbiMismatchError)
  })
})

/**
 * The hard deadlines are the contract's too: keeperDeadlines(roundId). The
 * keeper only checks that they are not before the calls they bound are due,
 * which is what a wrong decode would produce.
 */
describe('hard deadlines from keeperDeadlines', () => {
  const t = timesFromContract(RAW_TIMES)

  it('are taken as the contract states them (defaults: strikeEnd + 599, settleAt + 839)', () => {
    const d = checkDeadlines(1n, { fixStrikeBy: RAW_TIMES.strikeEnd + 599n, settleBy: RAW_TIMES.settleAt + 839n }, t)
    expect(d).toEqual({ fixStrikeBy: t.strikeEnd + 599, settleBy: t.settleAt + 839 })
    // Any other answer in range is taken as is: the keeper has no formula to argue with.
    expect(checkDeadlines(1n, { fixStrikeBy: RAW_TIMES.strikeEnd, settleBy: RAW_TIMES.settleAt }, t)).toEqual({ fixStrikeBy: t.strikeEnd, settleBy: t.settleAt })
  })

  it('refuses deadlines before the calls are even due, or not timestamps', () => {
    expect(() => checkDeadlines(1n, { fixStrikeBy: RAW_TIMES.strikeEnd - 1n, settleBy: RAW_TIMES.settleAt + 839n }, t)).toThrow(RoundsAbiMismatchError)
    expect(() => checkDeadlines(1n, { fixStrikeBy: RAW_TIMES.strikeEnd + 599n, settleBy: RAW_TIMES.settleAt - 1n }, t)).toThrow(/keeperDeadlines/)
    expect(() => checkDeadlines(1n, { fixStrikeBy: 2n ** 200n, settleBy: RAW_TIMES.settleAt }, t)).toThrow(RoundsAbiMismatchError)
  })
})

describe('refund reasons', () => {
  it('have names, the depth rule\'s included, and an unknown one is shown rather than dropped', () => {
    expect([0, 1, 2, 3, 4].map(reasonName)).toEqual(['priced', 'history-gone', 'spread', 'grace', 'thin-window'])
    expect(reasonName(9)).toBe('reason-9')
  })
})

function rawView(id: bigint, over: Partial<RawRoundView> = {}): RawRoundView {
  const { pool, duration, index } = decodeRoundId(id)
  return {
    pool, duration, index,
    times: { ...RAW_TIMES },
    committed: 10n, rawUp: 5n, rawDown: 5n, acceptedUp: 5n, acceptedDown: 5n, bank: 10n,
    minBank: 1n, costAllowance: 7n, bookClosed: true, activated: true, strikeFixed: false,
    outcome: 0, entryTick: 0, exitTick: 0,
    ...over,
  }
}

describe('checkRoundView', () => {
  const id = roundIdOf(POOL, 300, 5_966_666)
  const known = timesFromContract(RAW_TIMES)

  it('accepts a view that describes the round it was asked about', () => {
    const s = checkRoundView(id, rawView(id), known)
    expect(s).toMatchObject({ roundId: id, pool: POOL, duration: 300, costAllowance: 7n, activated: true, bookClosed: true })
    expect(s.times).toEqual(known)
    // Without roundTimes at hand the order check still applies.
    expect(checkRoundView(id, rawView(id), null).times).toEqual(known)
  })

  it('refuses a view whose identity or clock does not match: the ABI is wrong', () => {
    const other = getAddress('0x000000000000000000000000000000000000dead')
    expect(() => checkRoundView(id, rawView(id, { pool: other }), known)).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundView(id, rawView(id, { duration: 900n }), known)).toThrow(RoundsAbiMismatchError)
    expect(() => checkRoundView(id, rawView(id, { index: 1n }), known)).toThrow(RoundsAbiMismatchError)
    const moved = rawView(id)
    moved.times = { ...moved.times, settleAt: moved.times.settleAt + 1n }
    expect(() => checkRoundView(id, moved, known)).toThrow(/times.settleAt/)
    expect(() => checkRoundView(id, rawView(id, { outcome: 9 }), known)).toThrow(RoundsAbiMismatchError)
    const disordered = rawView(id)
    disordered.times = { ...disordered.times, strikeEnd: disordered.times.settleAt + 1n }
    expect(() => checkRoundView(id, disordered, null)).toThrow(RoundsAbiMismatchError)
  })

  /**
   * Why the check exists. roundView is a static struct: an ABI that lost a field
   * in the middle still decodes the same bytes, and every field after the gap
   * comes out shifted. viem refuses some shifts (a bool word that is not 0 or
   * 1), not all: here costAllowance is 1, so the word that lands in bookClosed
   * is a valid bool and the decode goes through. The shifted deadlines are even
   * still in order; they are caught because they are not what roundTimes said.
   */
  it('catches a struct decoded with a field missing in the middle', () => {
    const fn = POOL_ROUNDS_ABI.find((i) => i.type === 'function' && i.name === 'roundView')!
    const data = encodeFunctionResult({ abi: [fn], functionName: 'roundView', result: rawView(id, { costAllowance: 1n }) as any })
    const comps = (fn as any).outputs[0].components as any[]
    const withoutIndex = [{ ...fn, outputs: [{ ...(fn as any).outputs[0], components: comps.filter((c) => c.name !== 'index') }] }]
    const wrong = decodeFunctionResult({ abi: withoutIndex as any, functionName: 'roundView', data }) as any
    expect(() => checkRoundView(id, { ...wrong, index: id & (2n ** 64n - 1n) }, known)).toThrow(RoundsAbiMismatchError)
    // Sanity: the correct ABI decodes the same bytes into a view that passes.
    const right = decodeFunctionResult({ abi: [fn], functionName: 'roundView', data }) as RawRoundView
    expect(checkRoundView(id, right, known).committed).toBe(10n)
  })
})

describe('ROUNDS_ADDRESS / ROUNDS_START_BLOCK', () => {
  it('says what is wrong instead of throwing', () => {
    expect(roundsDeploymentFromEnv({})).toEqual({ error: 'ROUNDS_ADDRESS is not set' })
    expect(roundsDeploymentFromEnv({ ROUNDS_ADDRESS: 'nope' })).toHaveProperty('error')
    expect(roundsDeploymentFromEnv({ ROUNDS_ADDRESS: '0x' + '0'.repeat(40) })).toHaveProperty('error')
    expect(roundsDeploymentFromEnv({ ROUNDS_ADDRESS: POOL, ROUNDS_START_BLOCK: '12k' })).toHaveProperty('error')
  })

  it('checksums the address and reads the start block', () => {
    expect(roundsDeploymentFromEnv({ ROUNDS_ADDRESS: ` ${POOL.toLowerCase()} ` })).toEqual({ address: POOL, startBlock: null })
    expect(roundsDeploymentFromEnv({ ROUNDS_ADDRESS: POOL, ROUNDS_START_BLOCK: '54000123' })).toEqual({
      address: POOL, startBlock: 54_000_123n,
    })
  })
})

/**
 * The ABI above is a hand-kept copy; this is what keeps it honest. Whenever the
 * forge artifact exists (contracts: forge build), every item the keeper uses
 * must be in it with the same inputs, outputs, names and indexing, and every
 * discovery event must carry a roundId. A contract change that touches any of
 * them fails here first.
 */
const here = dirname(fileURLToPath(import.meta.url))
const ARTIFACT = resolve(here, '../../../contracts/out/PoolRounds.sol/PoolRounds.json')

describe.skipIf(!existsSync(ARTIFACT))('ABI against the forge artifact', () => {
  const strip = (p: any): any => ({
    name: p.name,
    type: p.type,
    ...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
    ...(p.components ? { components: p.components.map(strip) } : {}),
  })
  const norm = (i: any) => JSON.stringify({
    type: i.type,
    name: i.name,
    stateMutability: i.stateMutability,
    inputs: (i.inputs ?? []).map(strip),
    outputs: i.outputs ? i.outputs.map(strip) : undefined,
  })
  const artifact = () => JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi as any[]

  it('has every item the keeper uses, unchanged', () => {
    const abi = artifact()
    for (const item of POOL_ROUNDS_ABI) {
      const theirs = abi.find((a) => a.type === item.type && a.name === item.name)
      expect(theirs, `${item.type} ${item.name} is missing from PoolRounds`).toBeDefined()
      expect(norm(item), `${item.type} ${item.name}`).toBe(norm(theirs))
    }
  })

  it('names a round in every discovery event and a pool in every pool event, and has no commit-reveal left', () => {
    const abi = artifact()
    for (const name of DISCOVERY_EVENTS) {
      const ev = abi.find((a) => a.type === 'event' && a.name === name)
      expect(ev?.inputs.some((p: any) => p.name === 'roundId'), name).toBe(true)
    }
    for (const name of POOL_EVENTS) {
      const ev = abi.find((a) => a.type === 'event' && a.name === name)
      expect(ev?.inputs.some((p: any) => p.name === 'pool' && p.indexed), name).toBe(true)
    }
    // The contract's own deadline getter is there: the keeper has none of its own.
    expect(abi.find((a) => a.type === 'function' && a.name === 'keeperDeadlines')).toBeDefined()
    for (const gone of ['commit', 'reveal', 'revealWindow', 'Committed', 'Revealed']) {
      expect(abi.find((a) => a.name === gone), gone).toBeUndefined()
    }
  })
})
