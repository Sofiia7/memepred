import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'
import { MAX_BET, MIN_BET, CURRENCY_SYMBOL } from '../lib/contracts'
import { IS_POOL_BACKED } from '../lib/chain'

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
          Choose UP or DOWN for a meme coin's {IS_POOL_BACKED ? 'price in WETH' : 'USD price'} over a fixed window,
          then stake between {MIN_BET} and {MAX_BET} {CURRENCY_SYMBOL}.
        </Step>
        <Step n={2} title="You get matched">
          Your stake is matched against a trader who picked the opposite side, or on selected
          markets against the LP vault. If no match is available, the unmatched part can be
          refunded after 5 minutes.
        </Step>
        <Step n={3} title="The market settles">
          When the timeframe ends, {IS_POOL_BACKED ? 'the pool’s on-chain TWAP' : 'the RedStone oracle'} decides the
          winner. An exact tie returns both stakes.
        </Step>
        <Step n={4} title="Winner takes the pot">
          The winning side gets its matched pot less the displayed fees. You claim a winning
          payout yourself from the order page; tie refunds are returned automatically.
        </Step>
      </div>

      <div className="b-title">Good to know</div>
      <ul className="how-facts">
        <li>Non-custodial: {CURRENCY_SYMBOL} sits in the smart contract the whole time, not with us.</li>
        <li>Settlement is automatic and on-chain - there's no house to argue an outcome with.</li>
        <li>Queue information shows waiting orders, not the probability that UP or DOWN wins.
          The exact payout and fee are shown before you place a bet.</li>
        <li>This is a real-money product with real-money risk. You can lose your entire
          stake. Nothing here is investment advice, and past outcomes don't predict future
          ones.</li>
        <li>Contracts are open-source but have not yet gone through an external security
          audit.</li>
        <li>Full <Link to="/terms" style={{ color: 'var(--base-blue-2)' }}>Terms & Privacy</Link> - who
          runs this, eligibility, and what you're agreeing to.</li>
      </ul>

      <Link to="/" className="cta" style={{ marginTop: 16 }}>Back to markets</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
