import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { pythUpdatesUrl } from './pyth.js'

const PEPE = '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4'

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'https://api.flipthememe.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('pythUpdatesUrl', () => {
  /**
   * The whole reason this indirection exists.
   *
   * Hermes started requiring a bearer token on 2026-08-26. Vite inlines every
   * VITE_* value into the public bundle, so a browser that talks to Pyth
   * directly either has no key (401 - which is what broke placing bets) or
   * publishes ours. Either way the request has to go through our own backend.
   */
  it('never points the browser at Pyth directly', () => {
    expect(pythUpdatesUrl(PEPE, true)).not.toContain('pyth.network')
    expect(pythUpdatesUrl(PEPE, false)).not.toContain('hermes')
  })

  it('goes through our API', () => {
    expect(pythUpdatesUrl(PEPE, true)).toContain('https://api.flipthememe.com/api/pyth/updates')
  })

  it('asks for a parsed price when the caller wants to display one', () => {
    expect(pythUpdatesUrl(PEPE, true)).toContain('parsed=true')
  })

  it('asks for an unparsed payload when the caller is submitting it on-chain', () => {
    expect(pythUpdatesUrl(PEPE, false)).toContain('parsed=false')
  })

  // The backend whitelist matches on the 0x form; usePythPrice used to strip
  // the prefix before calling Hermes, which would now miss the whitelist and
  // come back 400.
  it('keeps the 0x prefix the backend whitelist expects', () => {
    expect(pythUpdatesUrl(PEPE, true)).toContain(`ids=${PEPE}`)
  })

  it('adds the prefix when a caller passes a bare hex id', () => {
    expect(pythUpdatesUrl(PEPE.slice(2), true)).toContain(`ids=${PEPE}`)
  })
})
