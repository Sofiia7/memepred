import { describe, expect, it } from 'vitest'
import { challengeText, challengeUrl, parseChallenge, shareLinks } from './challenge'
import { SIDE_DOWN, SIDE_UP } from './roundMath'
import { T_PLAYER, T_POOL, T_ROUND_ID, T_INDEX } from './testFixtures'

describe('challenge link', () => {
  it('offers the other side and names the challenger as referrer', () => {
    const url = challengeUrl('https://rhc.flipthememe.com/', T_ROUND_ID, SIDE_DOWN, T_PLAYER)
    expect(url).toBe(`https://rhc.flipthememe.com/rounds?round=${T_ROUND_ID}&take=up&ref=${T_PLAYER}`)
    const c = parseChallenge(new URL(url).search)
    expect(c).toEqual({ roundId: T_ROUND_ID, pool: T_POOL, duration: 300, index: T_INDEX, take: SIDE_UP, ref: T_PLAYER })
  })
  it('works without a referrer and rejects a broken link', () => {
    const c = parseChallenge(new URL(challengeUrl('https://x.test', T_ROUND_ID, SIDE_UP)).search)
    expect(c?.take).toBe(SIDE_DOWN)
    expect(c?.ref).toBeUndefined()
    expect(parseChallenge('?round=abc&take=up')).toBeNull()
    expect(parseChallenge(`?round=${T_ROUND_ID}&take=sideways`)).toBeNull()
    expect(parseChallenge(`?round=${T_ROUND_ID}&take=up&ref=nope`)?.ref).toBeUndefined()
    expect(parseChallenge('')).toBeNull()
  })
  it('text says my side, the stake, the coin and the side on offer', () => {
    const t = challengeText({ symbol: 'FROGGO', mySide: SIDE_DOWN, stake: '0.005 ETH', minutesLeft: 3, network: 'Robinhood Chain Testnet' })
    expect(t).toBe('I just bet DOWN 0.005 ETH on FROGGO on FlipTheMeme (Robinhood Chain Testnet). Bets close in 3 min. Think it goes UP? Take the other side:')
    expect(challengeText({ symbol: 'PEPE', mySide: SIDE_UP, stake: '0.01 ETH', minutesLeft: 0, network: 'n' })).toContain('Bets close any moment.')
  })
  it('share links carry the text and the url', () => {
    const l = shareLinks('hi there', 'https://x.test/rounds?round=1&take=up')
    expect(l.x).toContain('https://x.com/intent/post?text=hi%20there&url=')
    expect(Object.keys(l)).toEqual(['x'])
  })
  it('does not invite a bet into a closed round', () => {
    const text = challengeText({ symbol: 'PEPE', mySide: SIDE_UP, stake: '0.01 ETH', minutesLeft: 0, network: 'n', closed: true })
    expect(text).toContain('This round is closed.')
    expect(text).toContain('next available round')
    expect(text).not.toContain('Bets close any moment')
  })
})
