/**
 * ShareCard — Sprint 5.5 audit fix.
 *
 * Lets a winner share their result. Uses the Web Share API on mobile
 * (native share sheet — Farcaster/Twitter/Discord/iMessage all show up)
 * and falls back to copy-to-clipboard on desktop.
 *
 * Scope note: this shares TEXT + a link, not a per-position rendered image.
 * True per-position OG image previews need server-side rendering (the site
 * only serves one static og:image today — see index.html); that's a
 * separate infra project, not a client-only fix.
 */
import { useState } from 'react'

interface Props {
  direction:  'UP' | 'DOWN'
  amountUsd:  string
  payoutUsd:  string
}

export function ShareCard({ direction, amountUsd, payoutUsd }: Props) {
  const [copied, setCopied] = useState(false)

  const text = `🎯 Just won $${payoutUsd} predicting ${direction} on FlipTheMeme (staked $${amountUsd}). Predict meme coin prices on Base 👇`
  const url = window.location.origin

  async function handleShare() {
    if (navigator.share) {
      try {
        await navigator.share({ text, url })
        return
      } catch {
        // User cancelled the native share sheet — not an error.
        return
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable — silently do nothing rather than crash.
    }
  }

  return (
    <div className="share-card">
      <button className={'share-btn' + (copied ? ' copied' : '')} onClick={handleShare}>
        {copied ? '✓ Copied to clipboard' : '📤 Share your win'}
      </button>
    </div>
  )
}
