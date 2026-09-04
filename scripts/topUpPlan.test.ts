import { describe, it, expect } from 'vitest'
import { topUpAmount } from './topUpPlan.js'

describe('topUpAmount', () => {
  it('sends nothing while the balance is at or above the floor', () => {
    expect(topUpAmount(50n, 50n, 100n)).toBe(0n)
    expect(topUpAmount(80n, 50n, 100n)).toBe(0n)
  })

  it('tops a starved balance up to the target', () => {
    expect(topUpAmount(10n, 50n, 100n)).toBe(90n)
  })

  it('funds an empty wallet with the whole target', () => {
    expect(topUpAmount(0n, 50n, 100n)).toBe(100n)
  })

  /**
   * The rule this replaces sent a fixed `target` whenever the balance dipped
   * below the floor, so a bot sitting just under it kept accumulating - at the
   * old 0.01 ETH constant, thousands of transactions' worth of gas per bot,
   * which is what made a 50-bot soak look like it needed 0.5 ETH. Topping up
   * *to* the target instead is bounded: a bot never holds more than target.
   */
  it('never pushes a balance above the target', () => {
    expect(topUpAmount(49n, 50n, 100n)).toBe(51n)
    expect(49n + topUpAmount(49n, 50n, 100n)).toBe(100n)
  })

  /**
   * A floor above the target would otherwise mean "always starving, never
   * fundable" and quietly send a negative amount.
   */
  it('refuses a target below the floor rather than sending a negative amount', () => {
    expect(() => topUpAmount(10n, 100n, 50n)).toThrow(/target/i)
  })
})
