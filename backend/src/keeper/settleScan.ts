/**
 * settleScan - how one market's settlement queue is walked in one keeper tick.
 *
 * Split out of resolveKeeper.ts so the loop itself can be tested against a
 * scripted queue: the chain, the resolver and the wallet arrive as callbacks.
 *
 * The queue. OrderbookMarket keeps every match, in creation order, in
 * `pendingSettlements` (the entry at index i is match id i + 1, so its length
 * is nextMatchId - 1). `pendingSettlementsHead` is the first index that is not
 * settled yet, and getReadySettlements(offset, limit) looks at the window
 * [head + offset, head + offset + limit) and returns the matches in it that are
 * due and unsettled. Two facts about that queue carry this whole file:
 *
 *   - settleAt never decreases along it (settleAt = matchedAt + a duration that
 *     is fixed per market), so once a position is due every position before it
 *     is due too; and
 *   - a settled match stays settled.
 *
 * The problem. The head only moves over matches that reached a final state. A
 * match at the front that is due but that the resolver declines to settle (no
 * liquidity right now, an unproven pool failure, a refund that cannot complete)
 * pins the head, and everything settled behind it piles up as a dead stretch
 * between the stuck front and the live frontier. Reading from the head every
 * tick would never get past it.
 *
 * What is remembered between ticks (audit A08, and its regression fixed on
 * 2026-09-29). ONLY the end of the CONFIRMED-STUCK PREFIX: a window that held
 * due matches, whose dry run said the resolver would take none of them, and
 * that is followed by a window that also held due matches. The second
 * condition is what makes the first one mean something. "Window at offset X
 * came back empty" cannot tell settled from not-yet-due, or from past the end
 * of the queue, so progress through EMPTY windows must never be remembered:
 * the first version did exactly that, grew its remembered offset by up to 175
 * per tick until it pointed past the frontier, and from then on never read a
 * match appended behind a stuck head. And a stuck window's tail may hold
 * matches that are not due yet, so a stuck window is only vouched for once a
 * LATER window turns out to hold a due match: by the first fact above, every
 * position before that one is due, so the stuck window is entirely
 * settled-or-stuck.
 *
 * The remembered value is an ABSOLUTE index into the queue, not an offset from
 * the head. The head moves whenever anybody (this keeper, another caller of the
 * permissionless resolver, an emergency refund) settles the front; an offset
 * remembered from the old head would then land somewhere else, possibly past
 * live matches. It is clamped to the queue length on the way in and out, so it
 * can never point past the frontier, and dropped whenever the head window is
 * not stuck (it has healed, so the stuck prefix it described is gone). A
 * successful send at a window BEYOND the head window leaves it alone on
 * purpose: that send cannot touch a position the memory describes, and
 * forgetting it there would make every tick that settles anything re-walk the
 * whole stuck prefix, which is the cost the memory exists to remove.
 *
 * The remembered prefix is trusted only after two looks at it every tick: the
 * head window (which is read anyway) and the last window the memory vouches
 * for. Between them they catch the way it goes stale that matters: a cause that
 * heals every window at once while one match at the front stays stuck for its
 * own reasons. A window in the middle that heals alone is not seen until the
 * head window heals or the head moves; that costs a delayed resolution, never a
 * lost stake, because emergencyRefundMatch remains.
 *
 * What is NOT remembered is how far the empty stretch behind the stuck prefix
 * was walked: reading empty windows costs one view call each, so they get their
 * own budget per tick (maxEmptyWindows) instead of sharing the budget that
 * bounds dry runs and transactions (maxLoops).
 */

export interface QueueSnapshot {
  /** pendingSettlementsHead(): the first queue index that is not settled. */
  head: bigint
  /**
   * pendingSettlements.length, which is nextMatchId() - 1. Null when the
   * market does not expose it; the scan then cannot tell where the queue ends
   * and relies on its budgets alone.
   */
  length: bigint | null
}

export interface ScanIo {
  queue(): Promise<QueueSnapshot>
  /** Ids of the due, unsettled matches in the window `offset` past the head. */
  readWindow(offset: bigint): Promise<bigint[]>
  /**
   * Dry-run the resolver for that window: how many of its matches would reach
   * a final state (settled OR refunded), or null when the dry run reverts.
   */
  simulate(offset: bigint, ready: bigint[]): Promise<bigint | null>
  /** Send it for real. True when the transaction mined successfully. */
  send(offset: bigint, ready: bigint[], expected: bigint): Promise<boolean>
}

export interface ScanOptions {
  /** Window size, and the resolver's per-transaction cap. */
  step: bigint
  /** Windows per tick that cost a dry run (and possibly a transaction). */
  maxLoops: number
  /** Windows per tick that are only read, because nothing in them is due. */
  maxEmptyWindows: number
  /** Whether the deployed resolver can start a window past the head. */
  canPaginate: boolean
  /** The remembered end of the confirmed-stuck prefix, as an absolute queue index; 0n for none. */
  resume: bigint
}

export type ScanStop =
  | 'drained'         // nothing (more) is due at the head
  | 'frontier'        // walked to the end of the queue
  | 'loop-cap'        // out of dry runs for this tick, work may remain
  | 'empty-cap'       // out of free reads for this tick, the frontier was NOT reached
  | 'sim-reverted'    // the resolver would revert: do not send
  | 'tx-reverted'     // a transaction was mined and reverted
  | 'no-pagination'   // the head window is stuck and this resolver cannot look past it

export interface ScanResult {
  /** Store this for the next tick (absolute queue index, 0n for none). */
  resume: bigint
  /** Matches that reached a final state through transactions sent in this tick. */
  resolved: bigint
  txs: number
  /** Windows this tick found stuck. */
  stuckWindows: number
  emptyWindows: number
  stop: ScanStop
}

/**
 * Where to resume scanning after finding the window at `current` still stuck
 * this tick. All quantities are offsets from the head.
 *
 * Only jumps on the tick's first check (the head window itself, which is the
 * fresh look that confirms the stuck prefix has not healed since last tick)
 * and only when doing so is actual forward progress: a resume point at or
 * behind `current` falls back to the ordinary single-window step.
 */
export function nextStuckOffset(current: bigint, isFirstCheckThisTick: boolean, resumeFrom: bigint, step: bigint): bigint {
  return isFirstCheckThisTick && resumeFrom > current ? resumeFrom : current + step
}

/**
 * A remembered end clamped to what the queue can support: nothing at or behind
 * the head (that part of the prefix is gone), and never past the frontier.
 * Nothing at all when the market does not say how long its queue is.
 */
export function clampResume(resume: bigint, q: QueueSnapshot): bigint {
  // Without the queue length there is no telling where the frontier is, and no
  // way to keep an absolute position honest, so nothing is remembered.
  if (q.length === null) return 0n
  if (resume <= q.head) return 0n
  if (q.length <= q.head) return 0n
  return resume > q.length ? q.length : resume
}

const min = (a: bigint, b: bigint) => (a < b ? a : b)
const max = (a: bigint, b: bigint) => (a > b ? a : b)

export async function scanMarketQueue(io: ScanIo, opts: ScanOptions): Promise<ScanResult> {
  const { step, maxLoops, maxEmptyWindows, canPaginate } = opts

  let q = await io.queue()
  let mem = clampResume(opts.resume, q)
  // End of the latest stuck window that no later window has vouched for yet.
  let pending = 0n
  // Absolute queue index of the window being examined.
  let pos = q.head

  let loops = 0
  let empties = 0
  let stuckWindows = 0
  let txs = 0
  let resolved = 0n
  let stop: ScanStop

  for (;;) {
    if (q.length !== null && pos >= q.length) {
      stop = pos <= q.head ? 'drained' : 'frontier'
      break
    }

    const offset = canPaginate ? pos - q.head : 0n
    const ready = await io.readWindow(offset)

    if (ready.length === 0) {
      if (pos === q.head) {
        // Nothing due at the head, and settleAt never decreases along the
        // queue, so nothing is due anywhere. Whatever was remembered is moot.
        mem = 0n
        stop = 'drained'
        break
      }
      if (!canPaginate) { stop = 'drained'; break }
      if (empties >= maxEmptyWindows) { stop = 'empty-cap'; break }
      // Empty says nothing lasting: settled, not due yet, or past the end. Step
      // over it, and remember nothing about it.
      empties++
      pos += step
      continue
    }

    // Something here is due, so every position before it is due too, and the
    // stuck window just before this one is settled-or-stuck all the way to its
    // end. That is the only thing that lets the remembered end move.
    if (pending > 0n) {
      mem = max(mem, pending)
      pending = 0n
    }

    if (loops >= maxLoops) { stop = 'loop-cap'; break }
    loops++

    const would = await io.simulate(offset, ready)
    if (would === null) { stop = 'sim-reverted'; break }

    if (would === 0n) {
      // Every due match in this window is one the resolver declines right now.
      // Sending would cost a full gas ceiling to accomplish nothing; step past
      // them so what is behind stays reachable. They stay in the queue and
      // become refundable by anyone once SETTLE_GRACE lapses.
      if (!canPaginate) { stop = 'no-pagination'; break }
      stuckWindows++
      pending = q.length === null ? pos + step : min(pos + step, q.length)

      // The head window is looked at fresh every tick. Finding it still stuck
      // says the prefix has not healed, so it is safe to resume from where an
      // earlier tick vouched the prefix ended instead of re-stepping past the
      // same windows one dry run at a time.
      const atHead = pos === q.head
      // Less than a window away is inside the head window this tick has just
      // looked at, so there is nothing to jump over.
      let rel = mem - q.head > step ? mem - q.head : 0n

      if (atHead && rel > 0n && loops < maxLoops) {
        // A stuck head window is necessary for the remembered prefix to still
        // stand, not sufficient. A cause that heals everywhere at once (the pool
        // getting liquidity back) heals every window but this one when one match
        // at the front is stuck for a reason of its own, and the jump would then
        // skip matches that can be resolved right now. So the LAST window the
        // memory vouches for is looked at too, for the price of one more dry
        // run. Still stuck: the memory stands. Empty (somebody else resolved it)
        // or resolvable: it does not, and the scan walks from the head again.
        const anchor = rel - step
        const anchorReady = await io.readWindow(anchor)
        let stale = anchorReady.length === 0
        if (!stale) {
          loops++
          const anchorWould = await io.simulate(anchor, anchorReady)
          if (anchorWould === null) { stop = 'sim-reverted'; break }
          stale = anchorWould > 0n
        }
        if (stale) {
          mem = 0n
          rel = 0n
        }
      }

      pos = q.head + nextStuckOffset(pos - q.head, atHead, rel, step)
      continue
    }

    const ok = await io.send(offset, ready, would)
    txs++
    if (!ok) { stop = 'tx-reverted'; break }
    resolved += would

    // The queue moved. Read it again: the head may be somewhere else, and the
    // frontier may have grown.
    const wasHead = pos === q.head
    q = await io.queue()
    if (wasHead) {
      // The head window was not stuck: it has healed, and the prefix that was
      // remembered no longer describes this queue.
      mem = 0n
      pending = 0n
      pos = q.head
    } else if (q.length === null) {
      // The head is not known here, so `pos` is only an offset from a head that
      // may have moved. Start again from the head, whichever it now is.
      pos = q.head
    } else {
      pos = max(pos, q.head)
    }
    mem = clampResume(mem, q)
    // Read the same window again: what is left in it is declined, or new.
  }

  return { resume: clampResume(mem, q), resolved, txs, stuckWindows, emptyWindows: empties, stop }
}
