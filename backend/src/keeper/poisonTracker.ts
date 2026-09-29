/**
 * Visibility for an indexer that is stuck on one log.
 *
 * The orderbook stream keeps its cursor in step with what it has FULLY
 * processed, and a log whose handler throws is never skipped: skipping a log
 * that moves money is worse than stopping (audit A02). That is the right
 * compromise and it has one ugly consequence. A log that fails every time -
 * a numeric overflow in a projection column, an ABI that no longer decodes, a
 * pruned block - stops the stream for good, and nothing says so:
 *
 *   - the cursor never advances, so the same chunk is retried every tick;
 *   - the reconcilers that run after it in the same tick never run;
 *   - the invariant monitor compares balances at the frozen block, which
 *     agrees with itself, and reads ok.
 *
 * This counts consecutive failures of the SAME subject, logs CRITICAL once it
 * is clearly not a blip, and publishes one small record for the health probe
 * to read. It changes no behaviour of the indexer: it never skips anything.
 */
import { oneLine } from '../lib/errorText.js'

/** What failed: one log, or a step of a chunk that belongs to no single log. */
export interface PoisonSubject {
  txHash: string | null
  logIndex: number | null
  market: string | null
  event: string
}

export interface PoisonRecord extends PoisonSubject {
  /** Consecutive failures of this same subject. */
  failures: number
  firstFailedAt: number
  lastFailedAt: number
  /** First line of the last error, truncated. */
  error: string
}

/** Where the record goes. The indexer wires Redis in; tests use a fake. */
export interface PoisonSink {
  publish(record: PoisonRecord): Promise<void>
  clear(): Promise<void>
}

export const POISON_KEY = 'keeper:indexer:poison'
/**
 * Long enough to outlive a few failed ticks (the indexer ticks every 45s) and
 * short enough that a keeper which died with the flag up does not leave it
 * there: the watchdog going stale is what reports a dead keeper.
 */
export const POISON_TTL_SEC = 300

/** Failures in a row before this is called a stall rather than a blip. */
export const POISON_THRESHOLD = 3

export interface PoisonOptions {
  threshold?: number
  now?: () => number
  log?: (line: string) => void
}

function keyOf(s: PoisonSubject): string {
  return s.txHash === null ? `chunk:${s.event}` : `${s.txHash}:${s.logIndex}`
}

export class PoisonTracker {
  private state: { key: string; record: PoisonRecord } | null = null
  /**
   * Whether the sink has been cleared since this process started. A keeper
   * restart leaves the previous process's flag in Redis for up to its TTL, and
   * the new process has nothing in memory to say it was ever set.
   */
  private clearedSinceStart = false
  private readonly threshold: number
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly sink: PoisonSink, opts: PoisonOptions = {}) {
    this.threshold = opts.threshold ?? POISON_THRESHOLD
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((line) => console.error(line))
  }

  /** Consecutive failures currently recorded, 0 when the stream is not failing. */
  get failures(): number {
    return this.state?.record.failures ?? 0
  }

  /**
   * Record that `subject` failed. Returns how many times in a row it has.
   * Never throws: a Redis outage must not make the failure it is reporting
   * worse, and the caller rethrows the original error itself.
   */
  async failed(subject: PoisonSubject, err: unknown): Promise<number> {
    const key = keyOf(subject)
    const t = this.now()
    if (this.state && this.state.key === key) {
      this.state.record.failures += 1
      this.state.record.lastFailedAt = t
      this.state.record.error = oneLine(err)
    } else {
      this.state = {
        key,
        record: { ...subject, failures: 1, firstFailedAt: t, lastFailedAt: t, error: oneLine(err) },
      }
    }
    const rec = this.state.record
    if (rec.failures >= this.threshold) {
      this.log(
        `[indexer] CRITICAL: ${rec.event} ${rec.txHash ?? 'chunk'}#${rec.logIndex ?? '-'}` +
        `${rec.market ? ` on ${rec.market}` : ''} has failed ${rec.failures} times in a row since ` +
        `${new Date(rec.firstFailedAt).toISOString()}. The orderbook cursor is frozen and nothing behind ` +
        `this log is being indexed. Last error: ${rec.error}`,
      )
      try {
        await this.sink.publish({ ...rec })
      } catch (sinkErr) {
        this.log(`[indexer] could not publish the poison flag: ${oneLine(sinkErr)}`)
      }
    }
    return rec.failures
  }

  /**
   * A chunk went through. Whatever was failing is gone, so the flag comes
   * down: on the first success after this process starts (to clear a flag its
   * predecessor left), and whenever something had been failing.
   */
  async succeeded(): Promise<void> {
    if (this.state === null && this.clearedSinceStart) return
    this.state = null
    this.clearedSinceStart = true
    try {
      await this.sink.clear()
    } catch (sinkErr) {
      // Not remembered as cleared, so the next success tries again.
      this.clearedSinceStart = false
      this.log(`[indexer] could not clear the poison flag: ${oneLine(sinkErr)}`)
    }
  }
}

/** The minimal slice of a Redis client the sink needs. */
export interface RedisLike {
  setEx(key: string, seconds: number, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
}

export function redisPoisonSink(redis: RedisLike): PoisonSink {
  return {
    publish: async (record) => {
      await redis.setEx(POISON_KEY, POISON_TTL_SEC, JSON.stringify(record))
    },
    clear: async () => {
      await redis.del(POISON_KEY)
    },
  }
}
