import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChallengeShare } from './ChallengeShare'
import { T_PLAYER, T_ROUND_ID, milli } from './testFixtures'
import { parseChallenge } from './challenge'
import { SIDE_UP } from './roundMath'

afterEach(cleanup)
describe('sharing throughout a bet', () => {
  it('offers only X and copying, including after the close', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ChallengeShare roundId={T_ROUND_ID} mySide={SIDE_UP} stake={milli(5)} symbol="PEPE" closeAt={100} now={101} me={T_PLAYER} />)
    expect(screen.getByRole('link', { name: 'SHARE ON X' })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'COPY LINK' }))
    await screen.findByRole('button', { name: 'COPIED' })
    expect(writeText.mock.calls[0][0]).toContain('This round is closed.')
    expect(writeText.mock.calls[0][0]).not.toContain('Bets close any moment')
  })
  it('links a retired pool to its current replacement while retaining the referrer', () => {
    const replacement = T_ROUND_ID + 1n
    render(<ChallengeShare roundId={T_ROUND_ID} nextRoundId={replacement} mySide={SIDE_UP} stake={milli(5)} symbol="PEPE" closeAt={100} now={101} me={T_PLAYER} />)
    const href = new URL((screen.getByRole('link') as HTMLAnchorElement).href)
    const link = new URL(href.searchParams.get('url')!)
    expect(parseChallenge(link.search)?.roundId).toBe(replacement)
    expect(parseChallenge(link.search)?.ref).toBe(T_PLAYER)
  })
})
