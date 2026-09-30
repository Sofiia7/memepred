import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'
import { IS_POOL_BACKED } from '../lib/chain'
import { MAX_BET, CURRENCY_SYMBOL, SETTLE_GRACE_SEC, MATCH_TIMEOUT_SEC } from '../lib/contracts'
import { PRICE_JUMP_REFUND_PCT } from '../lib/rules'
import { joinList, restrictedNames } from '../lib/restrictedRegions'
import { ROUNDS_ENABLED } from '../rounds/flag'

const SETTLE_GRACE_HOURS = SETTLE_GRACE_SEC / 3600
const MATCH_TIMEOUT_MINUTES = MATCH_TIMEOUT_SEC / 60

const SECURITY_CONTACT = import.meta.env.VITE_SECURITY_CONTACT

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="terms-section">
      <h4>{n}. {title}</h4>
      <div>{children}</div>
    </div>
  )
}

export function TermsPage() {
  const showRounds = IS_POOL_BACKED && ROUNDS_ENABLED
  return (
    <>
      <ScreenTitle title="Terms & Privacy" />

      <div className="terms-notice">
        Not reviewed by a lawyer. This is a plain-language description of how
        the product actually works and what you're agreeing to by using it -
        not a substitute for legal advice, and not a guarantee of any
        particular legal outcome in your jurisdiction.
      </div>

      <h3 className="terms-h">Terms of Service</h3>
      <div className="terms-meta">Last updated: {showRounds ? '2026-09-30' : '2026-09-29'}</div>

      <Section n="1" title="Who runs this">
        FlipTheMeme is built and operated by an individual developer, not a
        registered company. There is no corporate entity standing between
        you and the operator. By connecting a wallet to this site or
        interacting with the FlipTheMeme smart contracts, you agree to these
        terms. If you don't agree, don't use it.
      </Section>

      <Section n="2" title="What this is">
        {IS_POOL_BACKED ? (
          <>
            Continuous markets are non-custodial, peer-to-peer prediction markets on Robinhood
            Chain. You stake {CURRENCY_SYMBOL} to bet on the short-term price
            direction (UP/DOWN) of a listed meme coin over a fixed window. The
            window is set per market and shown on it (the demo market runs 5
            minutes). Winners split the losing side's stake,
            minus the protocol fee (see the live contract - a percentage
            capped at 1%, applied to every winning bet whether it was matched
            against another trader or against the LP pool; an LP-matched win
            additionally pays a separate 1% LP taker fee on top of that,
            peer-matched wins do not). An exact tie - the settlement price
            equals the entry price - refunds both stakes in full, with no fee
            taken from either side. The same goes for a price jump of more than{' '}
            {PRICE_JUMP_REFUND_PCT}% at the end of the window, or a pool whose
            price history no longer covers it: both stakes are refunded
            immediately, with no fee and no winner. Settlement is automatic, driven by the
            token's own on-chain Uniswap v3 pool price (a time-weighted
            average, not an off-chain oracle). Nobody -including the
            operator- picks or can alter an outcome once it's settled
            on-chain.
          </>
        ) : (
          <>
            A non-custodial, peer-to-peer prediction market on Base. You deposit
            USDC to bet on the short-term price direction (UP/DOWN) of a listed
            meme coin over a fixed window (5 min to 24h). Winners split the
            losing side's stake, minus whatever fee applies (see the live
            contract - currently 0% for peer matches, 1% only when you beat the
            LP pool). Settlement is automatic, driven by the RedStone oracle. Nobody
            -including the operator- picks or can alter an outcome once it's
            settled on-chain.
          </>
        )}
      </Section>

      {showRounds && (
        <Section n="2a" title="Rounds on Robinhood Chain testnet">
          <p>
            Rounds are a separate testnet contract. Each wallet may place one UP or DOWN stake of 0.005-0.04 WETH in a
            round. Both sides' totals are public. Only equal amounts from the two sides play; each side's excess is
            returned without a fee. A round needs both sides and a matched bank of at least 0.02 WETH. If it does not
            activate, every stake is returned in full after bets close.
          </p>
          <p>
            The 5-minute betting window is followed by a 5-minute pause, a 5-minute strike average, and an exit price
            5 minutes later. The result is due about 20 minutes after bets opened. The price when you place your bet does
            not set the strike. If your side wins, you receive 1.96 times your matched stake plus any excess. The contract
            keeps 2% of the matched bank when there is a winner. On a tie or when an active round cannot be priced, it
            keeps 1% of the matched bank and returns the rest. If settlement is not completed within 24 hours of its due
            time, the round can be refunded with that 1% fee. You must call Collect for winnings and refunds; nothing is
            sent automatically. Gas for the approval, bet and collection is paid separately.
          </p>
          <p>
            A pool must clear the contract's depth gate, and the round's bank is limited by that pool's depth. The rule
            limits the size of a bet that can be affected by moving the pool price; it does not prevent manipulation.
            Testnet pools are stand-ins with scripted prices. The test tokens have no monetary value. See the{' '}
            <Link to="/rounds">Rounds screen</Link> for the current contract values and times before betting.
          </p>
        </Section>
      )}

      <Section n="3" title="Who can use this">
        You must be at least 18 (or the age of majority where you live) and
        legally permitted to use cryptocurrency products where you are, and
        you must not be accessing this from a <b>Restricted Territory</b>.
        Two separate lists make up that term:
        <ul className="terms-list">
          <li><b>Comprehensively sanctioned countries</b> - Cuba, Iran, North
            Korea, Syria. This one isn't a choice; it's U.S. sanctions law and
            it applies regardless of where an operator sits.</li>
          <li><b>Restricted jurisdictions</b> - {joinList(restrictedNames('long'), 'and', true)}.
            These are places whose regulators treat short-horizon price contracts
            like this one as a licensed derivatives or gambling product. This
            product holds no such licence anywhere, so it does not serve
            them. Tor exit nodes are blocked for the same reason.</li>
        </ul>
        Both are enforced at the network edge; the <b>live, authoritative
        list is always at</b> <code>/api/geo/config</code> - check that, not
        this document, for what's currently in force, since it can change
        without this page being reworded.{' '}
        <b>Do not attempt to circumvent this with a VPN or proxy.</b> Doing
        so is a breach of these terms, and it puts the legal problem on you:
        you are solely responsible for determining whether using this is
        legal for you.
        {IS_POOL_BACKED && (
          <p style={{ marginTop: 10 }}>
            <b>On Robinhood Chain specifically:</b> the policy above applies
            to both continuous markets and rounds. The edge checks the visitor's
            region before the app loads; the current blocked list is published
            by the API endpoint above. You remain responsible for determining
            whether using this is legal for you.
          </p>
        )}
      </Section>

      <Section n="4" title="Risks you're accepting">
        <ul className="terms-list">
          <li><b>You can lose everything you stake.</b> This is a zero-sum
            product for the losing side.</li>
          {IS_POOL_BACKED ? (
            <li><b>Smart contract risk - read this one twice.</b> The contracts
              have <b>not</b> undergone an external security audit. Nobody
              independent has checked them. Bugs are possible, and a bug in a
              contract holding {CURRENCY_SYMBOL} can mean the funds are simply
              gone, with no way to reverse it and no insurance behind them.{' '}
              <b>The single mitigation is a hard cap: no bet can exceed{' '}
              {MAX_BET} {CURRENCY_SYMBOL}</b> (<code>MAX_BET</code>, enforced
              in the contract, not the interface - the UI can't raise it and
              neither can the operator without deploying new contracts). That
              cap exists specifically so that the most an unaudited system can
              cost any one bet is a size you were willing to lose. It is a
              deliberate constraint on how much you can risk here, not a
              temporary limit to be worked around - and placing many bets to
              get around it re-exposes you to the full risk. If and when an
              audit happens, this section will say so and name the
              auditor.</li>
          ) : (
            <li><b>Smart contract risk - read this one twice.</b> The contracts
              have <b>not</b> undergone an external security audit. Nobody
              independent has checked them. Bugs are possible, and a bug in a
              contract holding USDC can mean the funds are simply gone, with no
              way to reverse it and no insurance behind them.{' '}
              <b>The single mitigation is a hard cap: no bet can exceed 100
              USDC</b> (<code>MAX_BET</code>, enforced in the contract, not the
              interface - the UI can't raise it and neither can the operator
              without deploying new contracts). That cap exists specifically so
              that the most an unaudited system can cost any one bet is a size
              you were willing to lose. It is a deliberate constraint on how
              much you can risk here, not a temporary limit to be worked around
              - and placing many bets to get around it re-exposes you to the
              full risk. If and when an audit happens, this section will say so
              and name the auditor.</li>
          )}
          {IS_POOL_BACKED ? (
            <li><b>Oracle risk in continuous markets.</b> Settlement depends on reading the token's
              own on-chain Uniswap v3 pool - a time-weighted average price, not
              a single spot tick. A pool that's too thin, too new, or drained
              out from under a position can't be read safely. What happens
              then depends on why. If the price jumps more than{' '}
              {PRICE_JUMP_REFUND_PCT}% at the end of the settlement window, or
              the pool's stored price history no longer covers that window, the
              match is not settled: both stakes are refunded immediately, with
              no fee and no winner. If the pool has no liquidity at that moment,
              settlement is skipped and retried rather than forced through on a
              bad price, and past a {SETTLE_GRACE_HOURS}-hour grace period from
              when the match was due, anyone can trigger a refund of both
              stakes instead - no fee either way.</li>
          ) : (
            <li><b>Oracle risk.</b> Settlement depends on RedStone price feeds.
              Staleness or unavailability can delay settlement or trigger a
              refund instead of a payout.</li>
          )}
          {IS_POOL_BACKED && (
            <li><b>Ties in continuous markets refund in full.</b> If the price at
              settlement is exactly equal to the entry price, both sides get
              their stake back in full and no fee is charged to either side -
              this is not a loss for either trader, and it is not a payout
              either.</li>
          )}
          {IS_POOL_BACKED ? (
            <li><b>No guaranteed counterparty in continuous markets.</b> If nobody's on the other
              side and the LP vault can't (or, on that market, isn't set up to)
              cover you, the unmatched part waits in the book. You can cancel it
              yourself at any time; if you don't, it stops matching after{' '}
              {MATCH_TIMEOUT_MINUTES} minutes and is refunded automatically. Only
              the part still waiting is held; whatever was matched keeps running
              on its own.</li>
          ) : (
            <li><b>No guaranteed counterparty.</b> If nobody's on the other
              side and the LP pool can't cover you, your bet is refunded - but
              it's locked for up to {MATCH_TIMEOUT_MINUTES} minutes while that's decided.</li>
          )}
          {showRounds && (
            <li><b>Round oracle risk.</b> The strike and exit are averages from the listed pool, which can still be
              manipulated. The contract limits the matched bank by pool depth. If an active round ties, lacks usable
              price history, or cannot meet its liquidity rule during the pricing window, it returns the matched
              stakes minus 1%; the player must call Collect. A round that never activates returns all stakes in full.</li>
          )}
          <li><b>Meme coins are extremely volatile</b> and can be manipulated,
            delisted from the price feed, or go to zero - independent of
            anything this product does.</li>
          <li><b>Nothing here is investment, legal, or tax advice.</b></li>
        </ul>
      </Section>

      <Section n="5" title="No accounts, no reversals">
        There's no account, no password, no customer support that can undo a
        transaction. Once something confirms on-chain, it's final - sending
        funds to the wrong address, approving the wrong contract, or any
        other mistake on your end is not recoverable.
      </Section>

      <Section n="6" title="Fees & referrals">
        {IS_POOL_BACKED && 'For continuous markets, '}
        the protocol fee is whatever the deployed market contract's <code>feeBps</code>{' '}
        currently is (changes for future continuous markets only through an on-chain 48h timelock, never
        instantly). {showRounds && 'Rounds have separate contract-enforced fees: 2% of the matched bank when there is a winner, and 1% on a tie or a refund of an active round. Unmatched stake and a round that never activates are returned without a fee. '}
        Referral rewards are paid directly by the smart contract
        from protocol fees - not a service the operator personally owes you -
        so if a contract bug over- or under-pays a referral, your recourse is
        governed by §8/§9 below, not treated as a billing dispute.
      </Section>

      <Section n="7" title="No warranty">
        The site and contracts are provided "as is," with no warranty of any
        kind - no guarantee of uptime, security, or being error-free.
      </Section>

      <Section n="8" title="Limitation of liability">
        To the maximum extent the law where you are allows, the operator is
        not liable for indirect, incidental, or consequential damages, or
        any loss of funds arising from your use of this product - even if
        the operator knew such loss was possible. (The contracts do have real
        safety mechanisms - reentrancy guards, pausability, a fee timelock,
        emergency-refund paths - but their existence reduces risk, it doesn't
        cancel this disclaimer.)
      </Section>

      <Section n="9" title="Indemnification">
        You agree to cover the operator for any claim arising from your own
        breach of these terms or violation of a law that applies to you.
      </Section>

      <Section n="10" title="Changes">
        These terms can change at any time by posting a revised version at
        this URL. Continuing to use the product after a change means you
        accept it.
      </Section>

      <Section n="11" title="Governing law">
        Not finalized. In the absence of a chosen jurisdiction clause, this
        defaults to whatever law would ordinarily apply to an individual
        operator - to be specified once formally reviewed.
      </Section>

      <Section n="12" title="Security disclosure">
        These contracts have not received an external security audit. If you
        find a vulnerability, do not exploit it or publish details that could
        put other users' funds at risk.{' '}
        {SECURITY_CONTACT ? (
          <>Report it privately to <b>{SECURITY_CONTACT}</b>. A paid bug bounty
          is not currently offered.</>
        ) : (
          <>A private reporting channel and paid bug bounty are not currently
          available. Do not put vulnerability details in a public issue.</>
        )}
      </Section>

      <h3 className="terms-h" style={{ marginTop: 24 }}>Privacy</h3>

      <Section n="P1" title="What's collected">
        Your wallet address (already public on-chain) linked to your bets,
        referral stats, streaks, and badges - that's what makes the
        leaderboard and portfolio pages work. Your country code is read at
        the network edge to enforce §3, used for that one request, and not
        stored. A pending referral code is cached in your own browser's
        localStorage until you place a bet - it never leaves your device
        except as an already-public on-chain argument at that point.
      </Section>

      <Section n="P2" title="What's NOT collected">
        No email, no name, no ID/KYC documents, no phone number. There's no
        account to create in the first place.
      </Section>

      <Section n="P3" title="Who else sees some of this">
        {IS_POOL_BACKED ? (
          <>
            Cloudflare (edge routing - sees your IP, like any reverse proxy
            would) and your own wallet/RPC provider. Settlement prices come
            from the token's own on-chain Uniswap v3 pool, not a third-party
            price vendor, so there is no oracle provider in this list on
            Robinhood Chain the way there is on Base.
          </>
        ) : (
          <>
            Cloudflare (edge routing - sees your IP, like any reverse proxy
            would), your own wallet/RPC provider, and RedStone (price data
            only, no personal data from you).
          </>
        )}
      </Section>

      <Link to="/how-it-works" className="cta" style={{ marginTop: 16 }}>Back to how it works</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
