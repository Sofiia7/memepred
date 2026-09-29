/**
 * RiskDisclosure - the "say it out loud" half of the unaudited-launch posture.
 *
 * FlipTheMeme is going live with contracts that no external auditor has
 * reviewed. That is a deliberate, defensible choice for a launch this small
 * ONLY if the tradeoff is stated plainly to users up front - a disclosure
 * buried in §4 of a Terms page nobody opens is not informed consent, it's
 * paperwork. So this ships in two parts:
 *
 *   1. <RiskGate>  - a one-time, blocking acknowledgement on first visit.
 *                    Requires an explicit click; no "X" to dismiss it past.
 *   2. <RiskStrip> - a permanent, non-dismissible line at the top of every
 *                    screen, so the state of things stays visible after the
 *                    gate is behind you rather than being a single moment
 *                    the user scrolled past once.
 *
 * The gate does not stand between a visitor and the rules they are being asked
 * to accept: /terms and /how-it-works render (inside the normal shell) before
 * acknowledgement. Everything else, every trading route included, stays gated.
 *
 * Remove both only when there is a real audit to point at. The cap is read
 * from lib/chain rather than restated here, because it used to be a literal
 * and a literal in a disclosure becomes a false statement the moment the
 * contract's own constant moves - which it does between deployments: 100 USDC
 * on Base, 0.04 WETH on Robinhood Chain.
 */
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MAX_BET, CURRENCY_SYMBOL, IS_POOL_BACKED } from '../lib/contracts'
import { PRICE_JUMP_REFUND_PCT, REFUND_GRACE_HOURS } from '../lib/rules'
import { restrictedNames } from '../lib/restrictedRegions'
import { NetworkPill } from './ui/NetworkPill'

const ACK_KEY = 'ftm_risk_ack_v1'

/**
 * The only routes shown before acknowledgement. Both are static reading: no
 * wallet action, no market, nothing that moves money. The Terms are what the
 * gate itself points at ("Full detail in the Terms"), so they cannot sit behind
 * it.
 */
const READABLE_BEFORE_ACK = ['/terms', '/how-it-works']

/**
 * React Router matches paths case-insensitively and ignores a trailing slash,
 * so this normalises the same way: `/Terms/` is the Terms page and must not be
 * gated, and no other path may normalise into one of the two above.
 */
export function isReadableBeforeAck(pathname: string): boolean {
  const p = pathname.toLowerCase().replace(/\/+$/, '')
  return READABLE_BEFORE_ACK.includes(p)
}

function readAck(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === '1'
  } catch {
    // Private mode / storage disabled - treat as un-acked. Showing the
    // notice again is the safe failure direction here.
    return false
  }
}

export function RiskStrip() {
  return (
    <div className="risk-strip" role="note">
      <b>UNAUDITED</b>
      <span className="sep">·</span>
      <span>max bet {MAX_BET} {CURRENCY_SYMBOL}</span>
      <span className="sep">·</span>
      <Link to="/terms">why</Link>
    </div>
  )
}

export function RiskGate({ children }: { children: React.ReactNode }) {
  // Read synchronously, so the gate is never flashed at someone who has
  // already accepted it and there is no blank frame while waiting to find out.
  const [acked, setAcked] = useState<boolean>(readAck)
  const { pathname } = useLocation()

  if (acked || isReadableBeforeAck(pathname)) return <>{children}</>

  const accept = () => {
    try {
      localStorage.setItem(ACK_KEY, '1')
    } catch {
      // Can't persist - the gate will show again next visit. Acceptable.
    }
    setAcked(true)
  }

  return (
    <div className="risk-gate">
      <div className="risk-gate-card">
        {/* The gate covers the shell, so it carries the network label itself. */}
        <NetworkPill />
        <div className="risk-gate-mark">⚠</div>
        <h2>Before you use this</h2>

        <p className="risk-lead">
          A few things you should know while you can still walk away.
        </p>

        <ol className="risk-points">
          <li>
            <b>The smart contracts have not been audited.</b> No independent
            security firm has reviewed the code holding the money. A bug could
            mean deposited {CURRENCY_SYMBOL} is lost permanently - there is no
            insurance, no reversal, and no support desk that can get it back.
          </li>
          <li>
            <b>That's why bets are capped at {MAX_BET} {CURRENCY_SYMBOL}.</b> The cap
            is enforced by the contract itself, not by this interface. It
            exists so the worst case stays a size you chose to risk. Treat it
            as the ceiling it is, not as a per-bet limit to place ten of.
          </li>
          <li>
            <b>You can lose your entire stake normally, too.</b> Even with
            perfect code - if the price goes the other way, the money goes to
            whoever took the other side. This is not investing.
          </li>
          {IS_POOL_BACKED && (
            <li>
              <b>The price comes from the token's own liquidity pool, and a
              thin pool can be pushed.</b> Settlement reads a time-weighted
              average rather than the spot price, but that window scales{' '}
              <b>down</b> with a market's own duration - so a shorter market is
              actually easier to move than a longer one, not harder. If the
              price jumps more than {PRICE_JUMP_REFUND_PCT}% at the end of the
              window, or the pool's history no longer covers it, nobody wins:
              both stakes are refunded immediately, with no fee. A pool with no
              liquidity at that moment is retried, and refunded after{' '}
              {REFUND_GRACE_HOURS} hours at the latest. A pool holding a
              few ETH can still be moved by someone willing to spend more
              than your bet is worth. The market will not exist at all below
              a minimum pool depth. It is not fully solved, and you should
              size your bets knowing that.
            </li>
          )}
        </ol>

        <p className="risk-fine">
          Not available in {restrictedNames('short').join(', ')}, or sanctioned
          countries. Full detail in the <Link to="/terms">Terms</Link>.
        </p>

        <button className="cta risk-accept" onClick={accept}>
          I understand - the contracts are unaudited
        </button>
      </div>
    </div>
  )
}
