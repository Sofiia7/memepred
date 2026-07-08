import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'
import { MAX_BET_USD, MIN_BET_USD } from '../lib/contracts'

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
  return (
    <>
      <ScreenTitle title="How it works" />

      <div className="how-steps">
        <Step n={1} title="Pick a coin, a direction, and a timeframe">
          Choose UP or DOWN for a meme coin's USD price over a fixed window (5 min to 24h),
          then stake between ${MIN_BET_USD} and ${MAX_BET_USD} USDC.
        </Step>
        <Step n={2} title="You get matched">
          Your stake is matched against a trader who picked the opposite side (peer match,
          no fee), or — if no one's on the other side yet — against the Genesis LP vault
          (a 1% fee applies only if you beat the pool). If neither is available within
          5 minutes, your stake is refunded automatically.
        </Step>
        <Step n={3} title="The market settles">
          When the timeframe ends, the Pyth oracle price decides the winner — nobody at
          FlipTheMeme picks or influences the outcome.
        </Step>
        <Step n={4} title="Winner takes the pot">
          The winning side gets 2× its matched stake (minus the LP fee if you were matched
          against the pool). You claim it yourself from the order page — funds aren't sent
          automatically.
        </Step>
      </div>

      <div className="b-title">Good to know</div>
      <ul className="how-facts">
        <li>Non-custodial: USDC sits in the smart contract the whole time, not with us.</li>
        <li>Settlement is automatic and on-chain — there's no house to argue an outcome with.</li>
        <li>The "% queue" shown on UP/DOWN buttons is how many other bets are waiting on
          each side right now, not a price — the payout is always 2× your stake if you win.</li>
        <li>This is a real-money product with real-money risk. You can lose your entire
          stake. Nothing here is investment advice, and past outcomes don't predict future
          ones.</li>
        <li>Contracts are open-source but have not yet gone through an external security
          audit.</li>
        <li>Full <Link to="/terms" style={{ color: 'var(--base-blue-2)' }}>Terms & Privacy</Link> — who
          runs this, eligibility, and what you're agreeing to.</li>
      </ul>

      <Link to="/" className="cta" style={{ marginTop: 16 }}>Back to markets</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
