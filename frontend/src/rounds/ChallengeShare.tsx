import { useState } from 'react'
import type { Address } from 'viem'
import { TARGET_CHAIN } from '../lib/chain'
import { formatAmount } from '../lib/money'
import { ROUNDS_CONFIG } from './roundsAbi'
import { sideLabel, type RoundSide } from './roundMath'
import { challengeText, challengeUrl, otherSide, shareLinks } from './challenge'

const SYMBOL = ROUNDS_CONFIG.nativeEth ? 'ETH' : 'WETH'

export interface ChallengeShareProps {
  roundId: bigint
  mySide: RoundSide
  stake: bigint
  symbol: string
  closeAt: number
  now: number
  /** The currently listed replacement pool's round, when the original pool was retired. */
  nextRoundId?: bigint
  /** The challenger's wallet: the link names it as referrer. */
  me?: Address
}

/**
 * "Take the other side": a link that opens this round with the opposite side
 * preselected and the challenger as referrer. A bettor brings their own
 * counterparty, which is what a 1:1 matched round needs most, and the
 * contract pays them the referral share of the fee on the friend's bets.
 */
export function ChallengeShare(p: ChallengeShareProps) {
  const [copied, setCopied] = useState(false)
  const closed = p.now >= p.closeAt || p.nextRoundId !== undefined
  const url = challengeUrl(window.location.origin, p.nextRoundId ?? p.roundId, p.mySide, p.me)
  const text = challengeText({
    symbol: p.symbol,
    mySide: p.mySide,
    stake: `${formatAmount(p.stake, 18)} ${SYMBOL}`,
    minutesLeft: Math.max(0, Math.round((p.closeAt - p.now) / 60)),
    network: TARGET_CHAIN.name,
    closed,
  })
  const links = shareLinks(text, url)
  const take = sideLabel(otherSide(p.mySide))

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // no clipboard (an old browser, a denied permission): the links below still work
    }
  }
  return (
    <div className="rnd-share" aria-label="Challenge a friend">
      <p>
        {closed ? `Share your ${p.symbol} call. The link opens the next available round with ${take} selected.` : `Dare someone to take ${take}. The link opens this round with ${take} selected.`}
      </p>
      <div className="rnd-share-row">
        <a className="rnd-btn ghost" href={links.x} target="_blank" rel="noopener noreferrer">SHARE ON X</a>
        <button type="button" className="rnd-btn ghost" onClick={() => void copy()}>
          {copied ? 'COPIED' : 'COPY LINK'}
        </button>
      </div>
    </div>
  )
}
