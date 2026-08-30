import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScreenTitle } from '../components/ui/AppShell'

/**
 * ⚠️ ACTION REQUIRED BEFORE LAUNCH - set a real security contact.
 *
 * §12 offers a paid bug bounty, which is the main compensating control for
 * shipping unaudited contracts (§4). A bounty with nowhere to report to is
 * worse than no bounty: it reads as a promise that can't be kept. Set this
 * to a channel that is actually monitored - a dedicated address such as
 * security@flipthememe.com, or a Telegram/X handle - via
 * VITE_SECURITY_CONTACT, and the placeholder disappears.
 */
const SECURITY_CONTACT: string =
  import.meta.env.VITE_SECURITY_CONTACT ||
  '[NOT YET PUBLISHED - no security contact has been set up. Until one is, ' +
  'do not rely on being able to reach anyone about a vulnerability.]'

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
        the product actually works and what you're agreeing to by using it -
        not a substitute for legal advice, and not a guarantee of any
        particular legal outcome in your jurisdiction.
      </div>

      <h3 className="terms-h">Terms of Service</h3>
      <div className="terms-meta">Last updated: 2026-08-30</div>

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
        contract - currently 0% for peer matches, 1% only when you beat the
        LP pool). Settlement is automatic, driven by the RedStone oracle. Nobody
        -including the operator- picks or can alter an outcome once it's
        settled on-chain.
      </Section>

      <Section n="3" title="Who can use this">
        You must be at least 18 (or the age of majority where you live) and
        legally permitted to use cryptocurrency products where you are, and
        you must not be accessing this from a <b>Restricted Territory</b>.
        Two separate lists make up that term:
        <ul className="terms-list">
          <li><b>Comprehensively sanctioned countries</b> - Cuba, Iran, North
            Korea, Syria. This one isn't a choice; it's U.S. sanctions law and
            it applies regardless of where an operator sits.</li>
          <li><b>Restricted jurisdictions</b> - the United States (including
            Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the
            Northern Mariana Islands), the United Kingdom, France, Germany,
            the Netherlands, Canada, Australia, Japan, and Singapore. These
            are places whose regulators treat short-horizon price contracts
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
      </Section>

      <Section n="4" title="Risks you're accepting">
        <ul className="terms-list">
          <li><b>You can lose everything you stake.</b> This is a zero-sum
            product for the losing side.</li>
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
          <li><b>Oracle risk.</b> Settlement depends on RedStone price feeds.
            Staleness or unavailability can delay settlement or trigger a
            refund instead of a payout.</li>
          <li><b>No guaranteed counterparty.</b> If nobody's on the other
            side and the LP pool can't cover you, your bet is refunded - but
            it's locked for up to 5 minutes while that's decided.</li>
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
        The protocol fee is whatever the deployed contract's <code>feeBps</code>{' '}
        currently is (changes only through an on-chain 48h timelock, never
        instantly). Referral rewards are paid directly by the smart contract
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

      <Section n="12" title="Security disclosure & bug bounty">
        Because these contracts are unaudited (§4), responsible disclosure is
        the main line of defence and it is paid for. If you find a bug that
        can cause loss of user funds, incorrect settlement, or a bypass of
        the <code>MAX_BET</code> cap, report it privately{' '}
        <b>before</b> using it or telling anyone else.
        <ul className="terms-list">
          <li><b>Where:</b> {SECURITY_CONTACT}</li>
          <li><b>Reward:</b> paid in USDC, scaled to what the bug could have
            cost users, and paid whether or not the report ends up being the
            first one received for that issue.</li>
          <li><b>Safe harbour:</b> testing against the deployed contracts is
            explicitly permitted, and the operator will not pursue any claim
            against a reporter who acts in good faith - meaning: stays within
            the <code>MAX_BET</code> cap while testing, does not touch other
            users' funds, does not degrade the service for others, and gives
            a reasonable window to fix before publishing.</li>
        </ul>
        This is not a substitute for an audit and is not presented as one.
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
        Cloudflare (edge routing - sees your IP, like any reverse proxy
        would), your own wallet/RPC provider, and RedStone (price data
        only, no personal data from you).
      </Section>

      <Link to="/how-it-works" className="cta" style={{ marginTop: 16 }}>Back to how it works</Link>
      <div style={{ height: 24 }} />
    </>
  )
}
