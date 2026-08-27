import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureReferralCode, getPendingReferrer } from './referral'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const STORAGE_KEY = 'flipthememe:pendingReferrer'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('getPendingReferrer', () => {
  it('returns the zero address when nothing was ever captured', () => {
    expect(getPendingReferrer()).toBe(ZERO_ADDRESS)
  })

  it('returns the persisted referrer once one was stored', () => {
    const addr = '0x000000000000000000000000000000000000dead'
    localStorage.setItem(STORAGE_KEY, addr)
    expect(getPendingReferrer()).toBe(addr)
  })

  // OrderbookMarket._placeBet has require(referrer != msg.sender), so passing
  // your own address is a hard revert — and clicking your own share link is the
  // obvious way to end up in that state.
  it('drops a self-referral so the bet does not revert', () => {
    const me = '0x000000000000000000000000000000000000dead'
    localStorage.setItem(STORAGE_KEY, me)
    expect(getPendingReferrer(me)).toBe(ZERO_ADDRESS)
  })

  it('compares addresses case-insensitively', () => {
    localStorage.setItem(STORAGE_KEY, '0x000000000000000000000000000000000000DEAD')
    expect(getPendingReferrer('0x000000000000000000000000000000000000dead')).toBe(ZERO_ADDRESS)
  })

  it('still returns a genuine referrer when it is someone else', () => {
    const other = '0x000000000000000000000000000000000000beef'
    localStorage.setItem(STORAGE_KEY, other)
    expect(getPendingReferrer('0x000000000000000000000000000000000000dead')).toBe(other)
  })

  it('keeps working when no wallet is connected yet', () => {
    const other = '0x000000000000000000000000000000000000beef'
    localStorage.setItem(STORAGE_KEY, other)
    expect(getPendingReferrer(undefined)).toBe(other)
    expect(getPendingReferrer(null)).toBe(other)
  })
})

describe('captureReferralCode', () => {
  it('does nothing (no fetch) when the URL has no ?ref= param', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    Object.defineProperty(window, 'location', {
      value: new URL('https://flipthememe.com/'),
      writable: true,
    })

    captureReferralCode()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves ?ref=CODE and persists the returned referrer address', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.flipthememe.com')
    Object.defineProperty(window, 'location', {
      value: new URL('https://flipthememe.com/?ref=ABC123'),
      writable: true,
    })
    const referrer = '0x000000000000000000000000000000000000beef'
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ referrer }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    captureReferralCode()
    // captureReferralCode is fire-and-forget (best-effort); flush its promise chain.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.flipthememe.com/api/referral/resolve/ABC123',
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe(referrer)
  })

  it('never throws when the resolve call fails — best-effort only', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.flipthememe.com')
    Object.defineProperty(window, 'location', {
      value: new URL('https://flipthememe.com/?ref=ABC123'),
      writable: true,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    expect(() => captureReferralCode()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
