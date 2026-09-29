import { describe, it, expect } from 'vitest'
import {
  scanMarketQueue,
  nextStuckOffset,
  clampResume,
  type ScanIo,
  type ScanOptions,
  type ScanResult,
} from './settleScan'

/**
 * The settlement queue of one OrderbookMarket, as far as the scan can see it.
 *
 * Position i is match id i + 1 (pendingSettlements only ever grows by pushing
 * the next id). A match is READY when it is unsettled and due. `stuck` means
 * the resolver declines to take it to a final state however often it is asked;
 * every other ready match is taken in the window it is sent for. `head` follows
 * OrderbookMarket._advancePendingSettlementsHead: it skips settled matches at
 * the front and stops at the first unsettled one.
 */
class FakeMarket {
  matches: Array<{ due: boolean; settled: boolean; stuck: boolean }> = []
  head = 0
  reads = 0
  sims = 0
  sends = 0
  simReverts = false
  txReverts = false
  /** Every offset a window was read at, in order. */
  readOffsets: number[] = []
  /** A market without pendingSettlementsHead / nextMatchId. */
  hasQueueGetters = true

  add(opts: { due?: boolean; settled?: boolean; stuck?: boolean } = {}): number {
    this.matches.push({ due: opts.due ?? true, settled: opts.settled ?? false, stuck: opts.stuck ?? false })
    this.advanceHead()
    return this.matches.length
  }

  /** Time passes: everything before position `n` is now due (settleAt never decreases along the queue). */
  dueBefore(n: number) {
    for (let i = 0; i < Math.min(n, this.matches.length); i++) this.matches[i].due = true
  }

  /** Someone else (another caller of the resolver, an emergency refund) settles a position. */
  settleExternally(position: number) {
    this.matches[position].settled = true
    this.advanceHead()
  }

  private advanceHead() {
    while (this.head < this.matches.length && this.matches[this.head].settled) this.head++
  }

  private ready(i: number) {
    const m = this.matches[i]
    return !m.settled && m.due
  }

  private windowPositions(offset: number, limit = 25): number[] {
    const out: number[] = []
    for (let i = this.head + offset; i < Math.min(this.head + offset + limit, this.matches.length); i++) out.push(i)
    return out
  }

  /** What the deployed resolver would take to a final state for this window. */
  private settleable(offset: number): number[] {
    return this.windowPositions(offset).filter((i) => this.ready(i) && !this.matches[i].stuck)
  }

  /** Ready matches that are not settled: the ones a keeper still owes. */
  unsettledDue(): number[] {
    return this.matches.map((_, i) => i).filter((i) => this.ready(i))
  }

  io(): ScanIo {
    return {
      queue: async () => this.hasQueueGetters
        ? { head: BigInt(this.head), length: BigInt(this.matches.length) }
        : { head: 0n, length: null },
      readWindow: async (offset) => {
        this.reads++
        this.readOffsets.push(Number(offset))
        return this.windowPositions(Number(offset)).filter((i) => this.ready(i)).map((i) => BigInt(i + 1))
      },
      simulate: async (offset) => {
        this.sims++
        return this.simReverts ? null : BigInt(this.settleable(Number(offset)).length)
      },
      send: async (offset) => {
        this.sends++
        if (this.txReverts) return false
        for (const i of this.settleable(Number(offset))) this.matches[i].settled = true
        this.advanceHead()
        return true
      },
    }
  }
}

const STEP = 25n
const opts = (over: Partial<ScanOptions> = {}): ScanOptions => ({
  step: STEP,
  maxLoops: 8,
  maxEmptyWindows: 40,
  canPaginate: true,
  resume: 0n,
  ...over,
})

async function tick(m: FakeMarket, resume: bigint, over: Partial<ScanOptions> = {}): Promise<ScanResult> {
  return scanMarketQueue(m.io(), opts({ resume, ...over }))
}

describe('nextStuckOffset', () => {
  it("jumps straight to a remembered resume point on the tick's first check", () => {
    expect(nextStuckOffset(0n, true, 500n, 25n)).toBe(500n)
  })

  it('falls back to a single step when nothing useful is remembered', () => {
    expect(nextStuckOffset(0n, true, 0n, 25n)).toBe(25n)
  })

  it('never jumps backwards past where this tick already is', () => {
    expect(nextStuckOffset(100n, true, 25n, 25n)).toBe(125n)
  })

  it('only jumps on the first check of a tick - later windows always step by one window', () => {
    expect(nextStuckOffset(25n, false, 500n, 25n)).toBe(50n)
  })
})

describe('clampResume', () => {
  it('forgets anything at or behind the head', () => {
    expect(clampResume(10n, { head: 10n, length: 100n })).toBe(0n)
    expect(clampResume(5n, { head: 10n, length: 100n })).toBe(0n)
  })

  it('can never point past the frontier', () => {
    expect(clampResume(400n, { head: 0n, length: 301n })).toBe(301n)
    expect(clampResume(50n, { head: 0n, length: 301n })).toBe(50n)
  })

  it('has nothing to remember when the queue is empty or its length is unknown', () => {
    expect(clampResume(50n, { head: 30n, length: 30n })).toBe(0n)
    expect(clampResume(50n, { head: 0n, length: null })).toBe(0n)
  })
})

/**
 * The regression this file exists for. The first fix for A08 (commit 35d276d)
 * remembered how far a tick had WALKED, empty windows included. Every tick it
 * jumped to the remembered offset, read empty windows past the stuck prefix,
 * added 25 for each and stored the result: up to +175 per tick, 700 a minute at
 * the 15 second cadence, until the offset was past the end of the queue. A match
 * appended behind the stuck head was then never read - it settled only when the
 * head was refunded, 24 hours later.
 */
describe('scanMarketQueue: one permanently stuck head, then a long settled stretch (audit A08 regression)', () => {
  function build() {
    const m = new FakeMarket()
    m.add({ stuck: true })                                       // position 0: the head, never taken
    for (let i = 0; i < 300; i++) m.add({ settled: true })       // positions 1..300: long since settled
    return m
  }

  it('reaches new due matches appended later, over many ticks, and never remembers more than the stuck prefix', async () => {
    const m = build()
    let resume = 0n

    for (let t = 0; t < 12; t++) {
      // Three fresh matches per tick; everything but the newest three is due by now.
      for (let i = 0; i < 3; i++) m.add({ due: false })
      m.dueBefore(m.matches.length - 3)

      const before = m.sims
      const r = await tick(m, resume)
      resume = r.resume

      // The confirmed-stuck prefix is the head's window: [0, 25). Nothing past
      // it may ever be remembered - the old code was at 175 after one tick.
      expect(r.resume).toBeLessThanOrEqual(25n)
      // Everything due except the permanently stuck head was reached this very tick.
      expect(m.unsettledDue()).toEqual([0])
      // And it is cheap: the head window, the window holding the new matches, at most one re-check.
      expect(m.sims - before).toBeLessThanOrEqual(3)
      expect(r.stop).toBe('frontier')
    }
    expect(resume).toBeLessThanOrEqual(25n)
  })

  it('does not let the remembered end creep while nothing new arrives', async () => {
    const m = build()
    let resume = 0n
    for (let t = 0; t < 60; t++) {
      const r = await tick(m, resume)
      resume = r.resume
      expect(r.resume).toBeLessThanOrEqual(25n)
    }
    // The old algorithm sat at 175 * 60 by now.
    expect(resume).toBeLessThanOrEqual(25n)
  })

  it('reports it plainly when the settled stretch is longer than one tick may read, and still remembers nothing about it', async () => {
    const m = new FakeMarket()
    m.add({ stuck: true })
    for (let i = 0; i < 2000; i++) m.add({ settled: true })
    m.add({ due: true })

    const r = await tick(m, 0n, { maxEmptyWindows: 40 })

    expect(r.stop).toBe('empty-cap')
    expect(r.resume).toBeLessThanOrEqual(25n)
    // Reading empty windows must not have eaten the budget for dry runs.
    expect(r.stuckWindows).toBe(1)
    expect(m.unsettledDue()).toContain(2001) // honestly not reached this tick
  })
})

describe('scanMarketQueue: the head', () => {
  it('drops the remembered prefix the moment the head window is no longer stuck, and settles it', async () => {
    const m = new FakeMarket()
    m.add({ stuck: true })
    for (let i = 0; i < 40; i++) m.add({ stuck: true })
    for (let i = 0; i < 10; i++) m.add({})
    // Two ticks to learn the prefix (it is stuck, and something due sits behind it).
    let r = await tick(m, 0n)
    r = await tick(m, r.resume)
    expect(r.resume).toBeGreaterThan(0n)

    // The pool recovers: nothing is stuck any more.
    for (const x of m.matches) x.stuck = false
    r = await tick(m, r.resume)

    expect(m.unsettledDue()).toEqual([])
    expect(r.resume).toBe(0n)
    expect(r.stop).toBe('drained')
  })

  it('has nothing to do when the head is not due, and forgets what it knew', async () => {
    const m = new FakeMarket()
    m.add({ due: false })
    const r = await tick(m, 40n)
    expect(r.stop).toBe('drained')
    expect(r.resume).toBe(0n)
    expect(m.sims).toBe(0)
  })

  it('handles a plain busy queue with nothing stuck: sends in windows from the head until it is drained', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 60; i++) m.add({})
    const r = await tick(m, 0n)
    expect(m.unsettledDue()).toEqual([])
    expect(r.resolved).toBe(60n)
    expect(r.txs).toBe(3) // 25 + 25 + 10
    expect(r.resume).toBe(0n)
    expect(r.stop).toBe('drained')
  })

  it('stops at the dry-run budget with work remaining, and picks the rest up next tick', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 250; i++) m.add({})
    let r = await tick(m, 0n, { maxLoops: 4 })
    expect(r.stop).toBe('loop-cap')
    expect(r.txs).toBe(4)
    expect(m.unsettledDue().length).toBe(150)
    r = await tick(m, r.resume, { maxLoops: 10 })
    expect(m.unsettledDue()).toEqual([])
  })
})

describe('scanMarketQueue: what is remembered', () => {
  it('remembers the end of a stuck run only once a later window proves the run is entirely due', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 60; i++) m.add({ stuck: true }) // positions 0..59, all due, all declined
    // Nothing behind them at all: the last stuck window is not vouched for.
    let r = await tick(m, 0n)
    expect(r.stuckWindows).toBe(3) // [0,25) [25,50) [50,75)
    expect(r.resume).toBe(50n)    // the start of the last window, never past it

    // A due match appears behind the run: now the whole run is vouched for.
    m.add({})
    r = await tick(m, r.resume)
    expect(m.unsettledDue().length).toBe(60) // the new one was settled
    expect(r.resume).toBeLessThanOrEqual(60n)
    expect(r.resume).toBeGreaterThanOrEqual(50n)
  })

  it('never buries a not-yet-due match in the remembered prefix', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 30; i++) m.add({ stuck: true }) // 0..29 due and declined
    m.add({ due: false })                               // 30, 31: not due yet
    m.add({ due: false })
    let r = await tick(m, 0n)
    // The stuck window [25,50) also holds the two not-due matches, so it is not
    // vouched for; remembering its end would jump over them for good.
    expect(r.resume).toBeLessThanOrEqual(25n)

    // They come due and can be settled.
    m.dueBefore(m.matches.length)
    r = await tick(m, r.resume)
    expect(m.unsettledDue().length).toBe(30) // only the stuck run is left
    expect(m.matches[30].settled).toBe(true)
    expect(m.matches[31].settled).toBe(true)
  })

  it('builds the memory of a long stuck run across ticks, and once it is built reaches a fresh match in one tick', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 500; i++) m.add({ stuck: true })
    let resume = 0n
    let prev = 0n
    for (let t = 0; t < 8; t++) {
      const r = await tick(m, resume)
      expect(r.resume).toBeGreaterThanOrEqual(prev)   // only ever grows here...
      expect(r.resume).toBeLessThanOrEqual(500n)      // ...and never past the run
      prev = r.resume
      resume = r.resume
    }
    expect(resume).toBeGreaterThanOrEqual(475n)

    m.add({}) // a new due match behind 500 stuck ones
    const before = m.sims
    const r = await tick(m, resume)
    expect(m.matches[500].settled).toBe(true)
    expect(m.sims - before).toBeLessThanOrEqual(4) // head window, the last stuck window, the new one
    expect(r.resume).toBeLessThanOrEqual(500n)
  })

  it('stays correct when someone else moves the head: the remembered end is an absolute index', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 80; i++) m.add({ stuck: true })
    m.add({}) // position 80, due and settleable behind an 80-long stuck run
    let r = await tick(m, 0n)
    expect(m.matches[80].settled).toBe(true)
    const learned = r.resume
    expect(learned).toBeGreaterThan(0n)

    // The first ten positions get settled by somebody else; the head moves to 10.
    for (let i = 0; i < 10; i++) m.settleExternally(i)
    expect(m.head).toBe(10)
    // Another due match arrives behind the run.
    m.add({})
    r = await tick(m, learned)

    expect(m.matches[81].settled).toBe(true)
    expect(m.unsettledDue().every((i) => m.matches[i].stuck)).toBe(true)
    expect(r.resume).toBeLessThanOrEqual(80n)
  })

  describe('checking that the remembered prefix still stands', () => {
    /** 25 matches stuck for good at the head, 75 more stuck for now, one settleable behind them. */
    async function learned() {
      const m = new FakeMarket()
      for (let i = 0; i < 25; i++) m.add({ stuck: true })  // the head window: stuck for its own reasons
      for (let i = 0; i < 75; i++) m.add({ stuck: true })  // positions 25..99: stuck for a cause that can heal
      m.add({})                                            // position 100: settleable, vouches for the run
      let r = await tick(m, 0n)
      r = await tick(m, r.resume)
      expect(r.resume).toBe(100n)
      return { m, resume: r.resume }
    }

    it('stops trusting it when the last stuck window heals while the head window has not', async () => {
      const { m, resume } = await learned()

      // The pool gets its liquidity back: everything but the head's own problem can be resolved.
      for (let i = 25; i < 100; i++) m.matches[i].stuck = false
      m.add({}) // and a fresh match arrives behind them

      const r = await tick(m, resume)

      // The jump would have gone straight to 100 and left positions 25..99 to wait 24 hours.
      expect(m.unsettledDue()).toEqual(Array.from({ length: 25 }, (_, i) => i))
      expect(r.resume).toBeLessThanOrEqual(25n)
    })

    it('stops trusting it when nothing is due in the last window any more', async () => {
      const { m, resume } = await learned()

      // Somebody else resolved the last stuck window; a fresh match arrives behind the run.
      for (let i = 75; i < 100; i++) m.settleExternally(i)
      m.add({})

      const r = await tick(m, resume)
      expect(m.matches[101].settled).toBe(true)
      expect(r.resume).toBeLessThanOrEqual(75n)
    })

    it('keeps trusting it, at the price of one more dry run, while the last window is still stuck', async () => {
      const { m, resume } = await learned()
      m.add({})
      const before = m.sims
      const r = await tick(m, resume)

      expect(m.matches[101].settled).toBe(true)
      // head window, the last stuck window, the window with the new match: no re-walk of 25..99.
      expect(m.sims - before).toBeLessThanOrEqual(3)
      expect(r.resume).toBe(100n)
    })
  })

  it('clamps what it stores to the queue when a stuck window runs past the frontier', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 30; i++) m.add({ stuck: true })
    m.add({}) // 30: settled by the scan, which vouches for the run
    const r = await tick(m, 0n)
    expect(r.resume).toBeLessThanOrEqual(BigInt(m.matches.length))
  })
})

describe('scanMarketQueue: things that go wrong', () => {
  it('stops without sending when the dry run reverts, and keeps what it knew', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 30; i++) m.add({ stuck: true })
    m.add({})
    let r = await tick(m, 0n)
    const known = r.resume

    m.add({})
    m.simReverts = true
    const sends = m.sends
    r = await tick(m, known)
    expect(r.stop).toBe('sim-reverted')
    expect(m.sends).toBe(sends)
    expect(r.resume).toBe(known)
  })

  it('stops at a mined-but-reverted transaction instead of retrying it', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 10; i++) m.add({})
    m.txReverts = true
    const r = await tick(m, 0n)
    expect(r.stop).toBe('tx-reverted')
    expect(m.sends).toBe(1)
    expect(r.resolved).toBe(0n)
  })

  it('on a resolver that cannot page, sends from the head and stops at the first stuck window', async () => {
    const m = new FakeMarket()
    for (let i = 0; i < 30; i++) m.add({})
    let r = await tick(m, 0n, { canPaginate: false })
    expect(m.unsettledDue()).toEqual([])
    expect(r.stop).toBe('drained')

    // A whole window of stuck matches, and a settleable one just past it: the
    // old resolver cannot start a window later than the head, so it stops.
    const stuck = new FakeMarket()
    for (let i = 0; i < 25; i++) stuck.add({ stuck: true })
    stuck.add({})
    r = await tick(stuck, 0n, { canPaginate: false })
    expect(r.stop).toBe('no-pagination')
    expect(stuck.sends).toBe(0)
    expect(stuck.matches[25].settled).toBe(false)

    // The same queue on a resolver that can page gets past it.
    r = await tick(stuck, 0n, { canPaginate: true })
    expect(stuck.matches[25].settled).toBe(true)
  })

  it('starts again from the head after a send when it cannot see the queue, instead of trusting an offset from a head that may have moved', async () => {
    const m = new FakeMarket()
    m.hasQueueGetters = false
    for (let i = 0; i < 25; i++) m.add({ stuck: true }) // a full stuck window at the head
    for (let i = 0; i < 5; i++) m.add({})               // settleable, one window further on
    const r = await tick(m, 0n)

    expect(m.matches[25].settled).toBe(true)
    // head window, the next one (sent), then the head window again - not the same offset a second time.
    expect(m.readOffsets.slice(0, 3)).toEqual([0, 25, 0])
    expect(r.resume).toBe(0n)
  })

  it('still settles what is behind a stuck head on a market that does not expose its queue, remembering nothing', async () => {
    const m = new FakeMarket()
    m.hasQueueGetters = false
    m.add({ stuck: true })
    for (let i = 0; i < 60; i++) m.add({ settled: true })
    m.add({})
    const r = await tick(m, 40n)
    expect(m.matches[61].settled).toBe(true)
    expect(r.resume).toBe(0n)
  })
})
