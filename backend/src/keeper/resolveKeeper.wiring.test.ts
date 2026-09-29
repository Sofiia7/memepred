import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector } from 'viem'

/**
 * resolveKeeper end to end against a scripted chain.
 *
 * settleScan.test.ts proves the walk. This proves the keeper actually drives it:
 * that the ABI names, the calldata, the dry-run decode and the send line up with
 * a resolver and a market, that state survives from tick to tick, and that the
 * refund sweep stops feeding a row that can never be refunded.
 */

const h = vi.hoisted(() => ({
  chain: null as any,
  pgQuery: vi.fn(),
  MARKET: '0x00000000000000000000000000000000000000aa',
  RESOLVER: '0x1111111111111111111111111111111111111111',
  FACTORY: '0xC52b8b69d266F9656Be11511907192EaFD521BcB',
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: (a: unknown) => h.chain.readContract(a),
      call: (a: unknown) => h.chain.call(a),
      estimateGas: (a: unknown) => h.chain.estimateGas(a),
      getCode: (a: unknown) => h.chain.getCode(a),
      waitForTransactionReceipt: (a: unknown) => h.chain.waitForTransactionReceipt(a),
    }),
  }
})
vi.mock('../db/pg.js', () => ({ pg: { query: (...a: unknown[]) => h.pgQuery(...a) } }))
vi.mock('../config.js', () => ({
  CONTRACTS: { ORACLE_RESOLVER: h.RESOLVER, MARKET_FACTORY: h.FACTORY },
}))
vi.mock('../chainProfile.js', () => ({
  CHAIN_PROFILE: { name: 'rhc', chain: { id: 46630 }, rpcUrl: 'http://rpc.invalid', oraclePayloadInCalldata: false },
}))
vi.mock('./keeperWallet.js', () => ({
  getKeeperWalletClient: () => ({
    account: { address: '0xkeeper' },
    sendTransaction: (a: unknown) => h.chain.sendTransaction(a),
  }),
  sendKeeperTx: async (send: (fees: object) => unknown) => send({}),
}))
vi.mock('./gasGuardInstance.js', () => ({
  gasGuard: { check: async () => null },
  recordReceipt: async () => {},
}))
vi.mock('../lib/redstone.js', () => ({
  fetchPayload: async () => '',
  withPayload: (encoded: string) => encoded,
  bytes32ToFeedId: () => '',
}))

const { settlePendingMarkets, refundOverdueMatches, resetResolveKeeperState } = await import('./resolveKeeper.js')
const { BATCH_FROM_SELECTOR } = await import('./resolverAbi.js')

const BATCH_ABI = parseAbi([
  'function resolveOrderbookMarketBatchFrom(address market, uint256 offset, uint256 maxCount) returns (uint256 settled)',
])
const REFUND_ABI = parseAbi(['function emergencyRefundMatch(uint256 matchId)'])

/** OrderbookMarket's settlement queue and the resolver that works it, seen from the RPC. */
class FakeChain {
  matches: Array<{ due: boolean; settled: boolean; stuck: boolean }> = []
  head = 0
  readyReads = 0
  dryRuns = 0
  txs = 0
  queueGetters = true
  refundReverts = false
  refundDryRuns = 0

  add(o: { due?: boolean; settled?: boolean; stuck?: boolean } = {}) {
    this.matches.push({ due: o.due ?? true, settled: o.settled ?? false, stuck: o.stuck ?? false })
    this.advance()
  }
  dueBefore(n: number) {
    for (let i = 0; i < Math.min(n, this.matches.length); i++) this.matches[i].due = true
  }
  private advance() {
    while (this.head < this.matches.length && this.matches[this.head].settled) this.head++
  }
  private window(offset: number, limit: number) {
    const out: number[] = []
    for (let i = this.head + offset; i < Math.min(this.head + offset + limit, this.matches.length); i++) out.push(i)
    return out
  }
  private ready(i: number) { return !this.matches[i].settled && this.matches[i].due }
  private takes(offset: number, limit: number) { return this.window(offset, limit).filter((i) => this.ready(i) && !this.matches[i].stuck) }
  unsettledDue() { return this.matches.map((_, i) => i).filter((i) => this.ready(i)) }

  readContract({ functionName, args }: { functionName: string; args?: bigint[] }) {
    switch (functionName) {
      case 'getReadySettlements': {
        this.readyReads++
        return this.window(Number(args![0]), Number(args![1])).filter((i) => this.ready(i)).map((i) => BigInt(i + 1))
      }
      case 'pendingSettlementsHead':
        if (!this.queueGetters) throw new Error('execution reverted')
        return BigInt(this.head)
      case 'nextMatchId':
        if (!this.queueGetters) throw new Error('execution reverted')
        return BigInt(this.matches.length + 1)
      case 'feedId':
        return '0x' + '00'.repeat(12) + 'aa'.repeat(20)
      default:
        throw new Error(`unscripted read ${functionName}`)
    }
  }
  getCode() { return `0x6080${BATCH_FROM_SELECTOR.slice(2)}00` }
  call({ to, data }: { to: string; data: `0x${string}` }) {
    if (to.toLowerCase() === h.RESOLVER.toLowerCase()) {
      this.dryRuns++
      const { args } = decodeFunctionData({ abi: BATCH_ABI, data })
      const n = this.takes(Number(args[1]), Number(args[2])).length
      return { data: encodeFunctionResult({ abi: BATCH_ABI, functionName: 'resolveOrderbookMarketBatchFrom', result: BigInt(n) }) }
    }
    // emergencyRefundMatch on a market
    this.refundDryRuns++
    if (this.refundReverts) throw Object.assign(new Error('reverted'), { shortMessage: 'execution reverted: paused' })
    decodeFunctionData({ abi: REFUND_ABI, data })
    return { data: '0x' }
  }
  sendTransaction({ to, data, gas }: { to: string; data: `0x${string}`; gas: bigint }) {
    this.txs++
    this.lastGas = gas
    if (to.toLowerCase() === h.RESOLVER.toLowerCase() && this.revertsLeft === 0) {
      const { args } = decodeFunctionData({ abi: BATCH_ABI, data })
      for (const i of this.takes(Number(args[1]), Number(args[2]))) this.matches[i].settled = true
      this.advance()
    }
    return '0xhash'
  }
  lastGas = 0n
  /** What eth_estimateGas answers; null makes it fail, like a node that cannot estimate. */
  estimate: bigint | null = null
  estimateGas() {
    if (this.estimate === null) throw new Error('cannot estimate')
    return this.estimate
  }
  /** Receipts come back reverted (out of gas) while this is positive; it counts down. */
  revertsLeft = 0
  waitForTransactionReceipt() {
    if (this.revertsLeft > 0) { this.revertsLeft--; return { status: 'reverted', gasUsed: this.lastGas } }
    return { status: 'success', gasUsed: 1n }
  }
}

beforeEach(() => {
  resetResolveKeeperState()
  h.chain = new FakeChain()
  h.pgQuery.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the selector the keeper detects pagination by', () => {
  it('is the real one for resolveOrderbookMarketBatchFrom', () => {
    expect(toFunctionSelector('resolveOrderbookMarketBatchFrom(address,uint256,uint256)')).toBe(BATCH_FROM_SELECTOR)
  })
})

describe('settlePendingMarkets (audit A08 regression, end to end)', () => {
  function pendingIs(...markets: string[]) {
    h.pgQuery.mockResolvedValue({ rows: markets.map((m) => ({ market_address: m })) })
  }

  it('reaches matches appended behind a stuck head on every tick, at a constant cost that does not grow', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    chain.add({ stuck: true })
    for (let i = 0; i < 300; i++) chain.add({ settled: true })

    const readsPerTick: number[] = []
    const dryRunsPerTick: number[] = []
    for (let tick = 0; tick < 15; tick++) {
      for (let i = 0; i < 3; i++) chain.add({ due: false })
      chain.dueBefore(chain.matches.length - 3)

      const reads = chain.readyReads
      const dry = chain.dryRuns
      await settlePendingMarkets()
      readsPerTick.push(chain.readyReads - reads)
      dryRunsPerTick.push(chain.dryRuns - dry)

      // Everything due except the permanently stuck head was resolved this tick.
      expect(chain.unsettledDue()).toEqual([0])
    }

    // The old code's remembered offset grew by 175 positions every tick. Dry runs
    // (the expensive part) are the same on the last tick as on the second, and
    // the free reads grow only with the settled stretch itself: 3 matches a tick
    // is one more 25-position window every eighth tick, not 7 a tick.
    expect(dryRunsPerTick[14]).toBe(dryRunsPerTick[1])
    expect(Math.max(...dryRunsPerTick)).toBeLessThanOrEqual(4)
    expect(readsPerTick[14] - readsPerTick[1]).toBeLessThanOrEqual(3)
  })

  it('only looks at markets of the current factory on rhc', async () => {
    pendingIs()
    await settlePendingMarkets()

    const sql = String(h.pgQuery.mock.calls[0][0])
    expect(sql).toContain(`factory_address = '${h.FACTORY.toLowerCase()}'`)
    expect(sql).toContain('mt.market_address IN (SELECT market_address FROM markets')
  })

  it('sends a window whose matches would all be refunded, and says "resolved", not "settled"', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    // The fake resolver takes every non-stuck ready match to a final state, which
    // is exactly how a window of refunds looks to the keeper: a non-zero count.
    for (let i = 0; i < 3; i++) chain.add()

    await settlePendingMarkets()

    expect(chain.txs).toBe(1)
    expect(chain.unsettledDue()).toEqual([])
    const lines = (console.log as any).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(lines.some((l: string) => l.includes('resolved 3 (settled or refunded)'))).toBe(true)
    expect(lines.some((l: string) => / settled \d+/.test(l))).toBe(false)
  })

  it('sizes the gas for the batch on rhc', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    for (let i = 0; i < 5; i++) chain.add()
    await settlePendingMarkets()
    // (120k + 5 * 260k) * 1.25
    expect(chain.lastGas).toBe(1_775_000n)
  })

  it('attaches at least 130% of what the node estimates for exactly this call', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    chain.add()
    chain.estimate = 900_000n // far more than the sized limit for one match (475k)
    await settlePendingMarkets()
    expect(chain.lastGas).toBe(1_170_000n)
  })

  it('does not resend a reverted settle with the same gas limit, and pauses the market after three in a row', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    chain.add()
    chain.revertsLeft = 5
    const limits: bigint[] = []
    for (let tick = 0; tick < 6; tick++) {
      await settlePendingMarkets()
      if (chain.txs > limits.length) limits.push(chain.lastGas)
    }
    // one-match sized limit is (120k + 260k) * 1.25 = 475,000, then 1.5x per revert
    expect(limits.slice(0, 3)).toEqual([475_000n, 712_500n, 1_068_750n])
    // three reverts in a row: the market is paused, so the following ticks send nothing
    expect(limits.length).toBe(3)
  })

  it('does not dry-run or send anything when the database was a tick behind and nothing is due', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    chain.add({ due: false })
    await settlePendingMarkets()
    expect(chain.dryRuns).toBe(0)
    expect(chain.txs).toBe(0)
  })

  it('still settles what is behind a stuck head on a market that does not expose its queue bounds', async () => {
    const chain: FakeChain = h.chain
    pendingIs(h.MARKET)
    chain.queueGetters = false
    chain.add({ stuck: true })
    for (let i = 0; i < 60; i++) chain.add({ settled: true })
    chain.add()

    await settlePendingMarkets()
    expect(chain.unsettledDue()).toEqual([0])
    // One line, once, however many ticks.
    await settlePendingMarkets()
    const warns = (console.warn as any).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(warns.filter((w: string) => w.includes('cannot read the settlement queue bounds'))).toHaveLength(1)
  })
})

describe('refundOverdueMatches parks a row that never refunds (audit follow-up, housekeeping)', () => {
  const ROW = { market_address: h.MARKET, match_id: '7' }

  it('stops offering the same stuck row after a few attempts, so it cannot hold a slot forever', async () => {
    const chain: FakeChain = h.chain
    chain.refundReverts = true
    // A database that honours the exclusion the keeper passes as the third parameter.
    h.pgQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const parked = (params[2] as string[]) ?? []
      return { rows: parked.includes(`${h.MARKET.toLowerCase()}:7`) ? [] : [ROW] }
    })

    for (let tick = 0; tick < 3; tick++) await refundOverdueMatches()
    expect(chain.refundDryRuns).toBe(3)

    // The fourth sweep no longer asks about it.
    await refundOverdueMatches()
    expect(chain.refundDryRuns).toBe(3)
    const lastParams = h.pgQuery.mock.calls[h.pgQuery.mock.calls.length - 1][1] as unknown[]
    expect(lastParams[2]).toEqual([`${h.MARKET.toLowerCase()}:7`])
  })

  it('only looks at overdue matches of the current factory on rhc', async () => {
    h.pgQuery.mockResolvedValue({ rows: [] })
    await refundOverdueMatches()
    expect(String(h.pgQuery.mock.calls[0][0])).toContain(`factory_address = '${h.FACTORY.toLowerCase()}'`)
  })

  it('a refund that goes through clears the row and sends a transaction', async () => {
    const chain: FakeChain = h.chain
    h.pgQuery.mockResolvedValue({ rows: [{ market_address: h.MARKET, match_id: '9' }] })
    await refundOverdueMatches()
    expect(chain.txs).toBe(1)
  })
})
