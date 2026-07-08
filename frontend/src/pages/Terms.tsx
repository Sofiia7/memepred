import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="terms-section">
      <h4>{n}. {title}</h4>
      <div>{children}</div>
    </div>
  )
}

export function TermsPage() {
  return (
    <>
      <ScreenTitle title="Terms & Privacy" />

      <div className="terms-notice">
        Not reviewed by a lawyer. This is a plain-language description of how
        the product actually works and what you're agreeing to by using it —
        not a substitute for legal advice, and not a guarantee of any
        particular legal outcome in your jurisdiction.
      </div>

      <h3 className="terms-h">Terms of Service</h3>
      <div className="terms-meta">Last updated: 2026-07-07</div>

      <Section n="1" title="Who runs this">
        FlipTheMeme is built and operated by an individual developer, not a
        registered company. There is no corporate entity standing between
        you and the operator. By connecting a wallet to this site or
        interacting with the FlipTheMeme smart contracts, you agree to these
        terms. If you don't agree, don't use it.
      </Section>

      <Section n="2" title="What this is">
        A non-custodial, peer-to-peer prediction market on Base. You deposit
        USDC to bet on the short-term price direction (UP/DOWN) of a listed
        meme coin over a fixed window (5 min to 24h). Winners split the
        losing side's stake, minus whatever fee applies (see the live
        contract — currently 0% for peer matches, 1% only when you beat the
        LP pool). Settlement is automatic, driven by the Pyth oracle. Nobody
        —including the operator— picks or can alter an outcome once it's
        settled on-chain.
      </Section>

      <Section n="3" title="Who can use this">
        You must be at least 18 (or the age of majority where you live), not
        accessing this from a country under comprehensive U.S. sanctions
        (currently Cuba, Iran, North Korea, Syria — enforced at the network
        edge, current list always at <code>/api/geo/config</code>), and
        legally permitted to use cryptocurrency products where you are.{' '}
        <b>You are solely responsible for determining whether using this is
        legal for you.</b> Broader jurisdiction restrictions may be added or
        removed over time — check the live list, not this document, for what's
        currently enforced.
      </Section>

      <Section n="4" title="Risks you're accepting">
        <ul className="terms-list">
          <li><b>You can lose everything you stake.</b> This is a zero-sum
            product for the losing side.</li>
          <li><b>Smart contract risk.</b> The contracts have not undergone an
            external security audit. Bugs are possible. You accept that risk.</li>
          <li><b>Oracle risk.</b> Settlement depends on Pyth price feeds.
            Staleness or unavailability can delay settlement or trigger a
            refund instead of a payout.</li>
          <li><b>No guaranteed counterparty.</b> If nobody's on the other
            side and the LP pool can't cover you, your bet is refunded — but
            it's locked for up to 5 minutes while that's decided.</li>
          <li><b>Meme coins are extremely volatile</b> and can be manipulated,
            delisted from the price feed, or go to zero — independent of
            anything this product does.</li>
          <li><b>Nothing here is investment, legal, or tax advice.</b></li>
        </ul>
      </Section>

      <Section n="5" title="No accounts, no reversals">
        There's no account, no password, no customer support that can undo a
        transaction. Once something confirms on-chain, it's final — sending
        funds to the wrong address, approving the wrong contract, or any
        other mistake on your end is not recoverable.
      </Section>

      <Section n="6" title="Fees & referrals">
        The protocol fee is whatever the deployed contract's <code>feeBps</code>{' '}
        currently is (changes only through an on-chain 48h timelock, never
        instantly). Referral rewards are paid directly by the smart contract
        from protocol fees — not a service the operator personally owes you —
        so if a contract bug over- or under-pays a referral, your recourse is
        governed by §8/§9 below, not treated as a billing dispute.
      </Section>

      <Section n="7" title="No warranty">
        The site and contracts are provided "as is," with no warranty of any
        kind — no guarantee of uptime, security, or being error-free.
      </Section>

      <Section n="8" title="Limitation of liability">
        To the maximum extent the law where you are allows, the operator is
        not liable for indirect, incidental, or consequential damages, or
        any loss of funds arising from your use of this product — even if
        the operator knew such loss was possible. (The contracts do have real
        safety mechanisms — reentrancy guards, pausability, a fee timelock,
        emergency-refund paths — but their existence reduces risk, it doesn't
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
        operator — to be specified once formally reviewed.
      </Section>

      <Section n="12" title="Contact">
        No public contact channel is set up yet.
      </Section>

      <h3 className="terms-h" style={{ marginTop: 24 }}>Privacy</h3>

      <Section n="P1" title="What's collected">
        Your wallet address (already public on-chain) linked to your bets,
        referral stats, streaks, and badges — that's what makes the
        leaderboard and portfolio pages work. Your country code is read at
        the network edge to enforce §3, used for that one request, and not
        stored. A pending referral code is cached in your own browser's
        localStorage until you place a bet — it never leaves your device
        except as an already-public on-chain argument at that point.
      </Section>

      <Section n="P2" title="What's NOT collected">
        No email, no name, no ID/KYC documents, no phone number. There's no
        account to create in the first place.
      </Section>

      <Section n="P3" title="Who else sees some of this">
        Cloudflare (edge routing — sees your IP, like any reverse proxy
        would), your own wallet/RPC provider, and Pyth Network (price data
        only, no personal data from you).
      </Section>

      <Link to="/how-it-works" className="cta" style={{ marginTop: 16 }}>Back to how it works</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
