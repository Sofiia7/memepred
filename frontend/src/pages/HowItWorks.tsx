import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'
import { MAX_BET, MIN_BET, CURRENCY_SYMBOL, MATCH_TIMEOUT_SEC, SETTLE_GRACE_SEC } from '../lib/contracts'
import { IS_POOL_BACKED } from '../lib/chain'
import { PRICE_JUMP_REFUND_PCT } from '../lib/rules'
import { ROUNDS_ENABLED } from '../rounds/flag'
import { ROUNDS_CONFIG } from '../rounds/roundsAbi'

// Read from the contract mirrors rather than retyped, like Terms does.
const MATCH_TIMEOUT_MIN = MATCH_TIMEOUT_SEC / 60
const REFUND_GRACE_HOURS = SETTLE_GRACE_SEC / 3600

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="how-step">
      <div className="how-step-n">{n}</div>
      <div>
        <div className="how-step-title">{title}</div>
        <div className="how-step-body">{children}</div>
      </div>
    </div>
  )
}

export function HowItWorksPage() {
  const showRounds = IS_POOL_BACKED && ROUNDS_ENABLED
  return (
    <>
      <ScreenTitle title="How it works" />

      {showRounds && (
        <>
          <div className="b-title">Rounds on Robinhood Chain testnet</div>
          <p>
            In <Link to="/rounds">Rounds</Link>, traders publicly stake UP or DOWN during a 5-minute betting window.
            The two sides play only up to the smaller side's total, one for one. The rest of each stake is returned without a fee.
            A round plays only when both sides stake enough for a matched bank of at least 0.01 {ROUNDS_CONFIG.nativeEth ? 'ETH' : 'WETH'}; otherwise every stake
            is returned in full after bets close.
          </p>
          <p>
            After betting closes, there is a 5-minute pause. The strike is averaged over the next minute, and the exit
            price is read 5 minutes later. The result is due about 16 minutes after betting opened, 11 minutes after bets close. Your bet is on the move
            from that future strike to the exit, not on the price when you bet.
          </p>
          <p>
            A winning side receives 1.96 times its matched stake, plus any unmatched part. The fee is 2% of the matched
            bank on a result. A tie or an unpriceable active round returns the matched stakes minus 1%. You must press
            Collect to receive winnings or refunds. The contract's pool-depth rule limits the bank, but price manipulation
            remains possible. These are testnet pools with scripted prices. {ROUNDS_CONFIG.nativeEth ? 'You stake and collect test ETH directly; the contract handles WETH internally.' : 'The stake is test WETH only.'}
          </p>
          <div className="b-title">Continuous markets</div>
        </>
      )}

      <div className="how-steps">
        <Step n={1} title="Pick a coin, a direction, and a timeframe">
          {IS_POOL_BACKED ? (
            <>
              Choose UP or DOWN for a meme coin's price in WETH over the window each market shows (the
              demo market runs 5 minutes), then stake between {MIN_BET} and {MAX_BET} {CURRENCY_SYMBOL}.
            </>
          ) : (
            <>
              Choose UP or DOWN for a meme coin's USD price over a fixed window, then stake between {MIN_BET} and{' '}
              {MAX_BET} {CURRENCY_SYMBOL}.
            </>
          )}
        </Step>
        <Step n={2} title="You get matched">
          {IS_POOL_BACKED ? (
            <>
              Your stake meets waiting orders from traders who picked the opposite side. On markets where
              the LP vault is enabled, the vault can take the other side of whatever is left; on other
              markets that part waits for another trader. Anything still unmatched waits in the book:
              cancel it any time, or after {MATCH_TIMEOUT_MIN} minutes it stops matching and is refunded
              automatically.
            </>
          ) : (
            <>
              Your stake is matched against a trader who picked the opposite side, or on selected
              markets against the LP vault. If no match is available, the unmatched part can be
              refunded after {MATCH_TIMEOUT_MIN} minutes.
            </>
          )}
        </Step>
        <Step n={3} title="The market settles">
          {IS_POOL_BACKED ? (
            <>
              When the window ends, the pool's on-chain TWAP decides the winner. An exact tie returns both
              stakes. If the price jumps more than {PRICE_JUMP_REFUND_PCT}% at the end of the window, or
              the pool has no price history for it, both stakes are refunded immediately with no fee. A
              pool with no liquidity at that moment is retried, and if it still cannot be priced{' '}
              {REFUND_GRACE_HOURS} hours after the window ended, anyone can trigger the refund.
            </>
          ) : (
            <>
              When the timeframe ends, the RedStone oracle decides the winner. An exact tie returns both
              stakes.
            </>
          )}
        </Step>
        <Step n={4} title="Winner takes the pot">
          The winning side gets its matched pot less the displayed fees. You claim a winning
          payout yourself from the order page; refunds (ties, windows that could not be priced,
          unmatched stake) go straight back to your wallet.
        </Step>
      </div>

      <div className="b-title">Good to know</div>
      <ul className="how-facts">
        <li>Non-custodial: {CURRENCY_SYMBOL} sits in the smart contract the whole time, not with us.</li>
        <li>Settlement is automatic and on-chain - there's no house to argue an outcome with.</li>
        <li>Queue information shows waiting orders, not the probability that UP or DOWN wins.
          The exact payout and fee are shown before you place a bet.</li>
        <li>{IS_POOL_BACKED ? 'This testnet demo uses test tokens. A live version would put real funds at risk.' : 'This is a real-money product with real-money risk.'} You can lose your entire
          stake. Nothing here is investment advice, and past outcomes don't predict future
          ones.</li>
        {IS_POOL_BACKED ? (
          <li>The contract source is published on the Robinhood Chain testnet explorer. The
            contracts have not yet gone through an external security audit.</li>
        ) : (
          <li>Contracts are open-source but have not yet gone through an external security
            audit.</li>
        )}
        <li>Full <Link to="/terms" style={{ color: 'var(--base-blue-2)' }}>Terms & Privacy</Link> - who
          runs this, eligibility, and what you're agreeing to.</li>
      </ul>

      <Link to="/" className="cta" style={{ marginTop: 16 }}>Back to markets</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
