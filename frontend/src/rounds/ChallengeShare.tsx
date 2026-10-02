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
  const url = challengeUrl(window.location.origin, p.roundId, p.mySide, p.me)
  const text = challengeText({
    symbol: p.symbol,
    mySide: p.mySide,
    stake: `${formatAmount(p.stake, 18)} ${SYMBOL}`,
    minutesLeft: Math.max(0, Math.round((p.closeAt - p.now) / 60)),
    network: TARGET_CHAIN.name,
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
  async function share() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text, url })
        return
      } catch {
        return // the sheet was closed
      }
    }
    await copy()
  }

  return (
    <div className="rnd-share" aria-label="Challenge a friend">
      <p>
        <b>Dare someone to take {take}.</b> The link opens this round with {take} preselected; their bets count as your
        referrals, and the round needs the other side to play.
      </p>
      <div className="rnd-share-row">
        <button type="button" className="rnd-btn" onClick={() => void share()}>
          {copied ? 'COPIED' : 'SHARE'}
        </button>
        <button type="button" className="rnd-btn ghost" onClick={() => void copy()}>
          COPY LINK
        </button>
        <a className="rnd-btn ghost" href={links.x} target="_blank" rel="noopener noreferrer">X</a>
        <a className="rnd-btn ghost" href={links.telegram} target="_blank" rel="noopener noreferrer">TELEGRAM</a>
        <a className="rnd-btn ghost" href={links.farcaster} target="_blank" rel="noopener noreferrer">FARCASTER</a>
      </div>
    </div>
  )
}
