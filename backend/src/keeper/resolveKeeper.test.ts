import { describe, it, expect } from 'vitest'
import { nextStuckOffset } from './resolveKeeper'

describe('nextStuckOffset (audit A08, 2026-09-28)', () => {
  it('jumps straight to a remembered resume point on the tick\'s first check', () => {
    // Confirmed stuck at 0 again this tick; a previous tick had already
    // walked as far as 500 - resume there instead of re-stepping from 0.
    expect(nextStuckOffset(0n, true, 500n, 25n)).toBe(500n)
  })

  it('falls back to a single step when nothing useful is remembered', () => {
    expect(nextStuckOffset(0n, true, 0n, 25n)).toBe(25n)
  })

  it('never jumps backwards past where this tick already is', () => {
    // A market seen for the first time this run, or one whose remembered
    // offset is stale relative to a since-shrunk queue.
    expect(nextStuckOffset(100n, true, 25n, 25n)).toBe(125n)
  })

  it('only jumps on the first check of a tick - later iterations always step by one window', () => {
    expect(nextStuckOffset(25n, false, 500n, 25n)).toBe(50n)
  })
})
