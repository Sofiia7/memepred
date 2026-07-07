# FlipTheMeme — Terms of Service & Privacy Policy (DRAFT)

> **⚠️ NOT LEGAL ADVICE. NOT FINAL. DO NOT PUBLISH AS-IS.**
> This is a structural first draft written by an AI assistant to save a
> lawyer's time, not to replace one. Before launch, a licensed attorney
> familiar with (a) the jurisdiction you incorporate in and (b) crypto/
> derivatives/gambling regulation in your target markets MUST review and
> revise this document. Every `[BRACKETED]` field is a placeholder that
> does not exist yet in this project and must be filled in with real,
> verified information before publishing. Do not treat any statement below
> as confirmed legal fact about FlipTheMeme's regulatory status — several
> jurisdictions treat prediction markets as regulated derivatives or
> gambling products regardless of the "skill" or "non-custodial" framing
> used here.

---

## Terms of Service

**Last updated: [DATE] — Version [X.X]**

### 1. Who this agreement is with

FlipTheMeme ("FlipTheMeme", "we", "us") is operated by [LEGAL ENTITY NAME —
e.g. "FlipTheMeme Labs Ltd.", jurisdiction of incorporation], registered at
[ADDRESS]. If no entity exists yet, do not launch to real users until one
does — operating a fee-taking financial product as an unincorporated
individual is a personal-liability risk, not just a compliance nicety.

By connecting a wallet to flipthememe.com (the "Site") or interacting with
the FlipTheMeme smart contracts (the "Protocol"), you agree to these Terms.
If you do not agree, do not use the Site or Protocol.

### 2. What FlipTheMeme is

FlipTheMeme is a non-custodial, PvP prediction market on Base. Users deposit
USDC to bet on the short-term price direction (UP/DOWN) of a listed
memecoin over a fixed timeframe (5m/15m/1h/4h/24h). Winners split the
losing side's stake, minus a protocol fee. Settlement is determined
automatically by an on-chain oracle (Pyth Network); FlipTheMeme does not
adjudicate outcomes and cannot alter settled results.

**Non-custodial:** USDC is held by the smart contracts, not by FlipTheMeme.
We do not have a mechanism to withdraw, freeze, or move user funds outside
the logic encoded in the audited (see §8) contract code.

### 3. Eligibility

You must be:
- At least 18 years old (or the age of majority in your jurisdiction, if
  higher).
- Not a resident of, or accessing the Site from, a **Restricted
  Territory**. As of this version, Restricted Territories include the
  United States, United Kingdom, France, Germany, Netherlands, Canada,
  Australia, Japan, and Singapore (enforced at the network edge — see
  `workers/geo-block.ts` — and subject to change; the current
  authoritative list is served at `/api/geo/config`).
- Not a person or entity subject to sanctions administered by the US
  Office of Foreign Assets Control (OFAC), the UN, the EU, or the UK, nor
  organized in, or a resident of, a comprehensively sanctioned country.
- Legally permitted to use cryptocurrency and participate in
  skill/chance-based financial products under the laws that apply to you.
  **You are solely responsible for determining whether your use of
  FlipTheMeme is lawful where you are.**

Accessing the Site through a VPN, proxy, or other means to circumvent the
Restricted Territory check is a violation of these Terms **and may
constitute fraud or a violation of local law independent of anything
FlipTheMeme does** — that risk is yours, not ours.

### 4. Risks you are accepting

By using the Protocol you acknowledge and accept, without limitation:

- **Total loss of funds.** Prediction markets are zero-sum for losers;
  you can lose 100% of any amount you stake.
- **Smart contract risk.** Even audited code can contain bugs. FlipTheMeme
  makes no guarantee the Protocol is free of defects, and you accept the
  risk of loss from any such defect.
- **Oracle risk.** Settlement depends on Pyth Network price feeds. Feed
  staleness, manipulation, or unavailability can cause incorrect
  settlement or delayed refunds (see the Protocol's own emergency-refund
  mechanisms, which exist specifically because this risk is real).
- **No guarantee of a counterparty.** If no opposing bet or liquidity-pool
  capacity is available within the match window, your bet is refunded
  automatically — but during that window your funds are locked in the
  contract.
- **Volatility of the underlying asset.** Memecoins are extremely
  volatile and can be subject to manipulation, rug pulls, or delisting
  from the price oracle, independent of FlipTheMeme.
- **No investment advice.** Nothing on the Site is investment, legal, or
  tax advice. FlipTheMeme is not a broker, exchange, or financial advisor.
- **Referral program.** Referral rewards are a share of protocol fees,
  not compensation for services, and are paid only if and when the
  smart-contract logic credits them. See §6.

### 5. No custody, no accounts, no reversals

FlipTheMeme does not create a user account, does not hold a private key on
your behalf, and cannot reverse a transaction once confirmed on-chain.
Losses due to sending funds to the wrong address, approving the wrong
contract, or any other user error are not recoverable by FlipTheMeme.

### 6. Fees & referrals

FlipTheMeme charges a protocol fee (currently `[X]%`, see the deployed
`OrderbookMarket.feeBps` — subject to change via the on-chain timelock
process, never instantly) on winning payouts. Referral rewards (currently
40% of the protocol fee generated by a referred trader — see
`FeeDistributor.REF_BPS`) are paid in USDC directly by the smart contract
and are not owed by FlipTheMeme as a company; if the contract has a bug that
under- or over-pays a referral, your remedy (if any) is governed by §7-9
below, not by treating it as a billing dispute with a company.

### 7. No warranty

THE SITE AND PROTOCOL ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT
WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. FLIPTHEMEME DOES NOT
WARRANT THAT THE SITE OR PROTOCOL WILL BE UNINTERRUPTED, SECURE, OR
ERROR-FREE.

### 8. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, FLIPTHEMEME AND ITS TEAM WILL NOT BE
LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
DAMAGES, OR ANY LOSS OF FUNDS, PROFITS, OR DATA, ARISING FROM YOUR USE OF
THE SITE OR PROTOCOL, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
[Insert jurisdiction-specific liability cap language here with counsel —
many jurisdictions require a cap to be a specific, reasonable figure to
be enforceable, not an unlimited disclaimer.]

*(Reference, not a claim of completion: contracts have internal safety
mechanisms — reentrancy guards, pausability, a 48h fee-change timelock,
emergency refund paths after grace periods — but their existence reduces
risk, it does not eliminate the legal disclaimers above.)*

### 9. Indemnification

You agree to indemnify and hold FlipTheMeme and its team harmless from any
claim arising from your breach of these Terms or your violation of any
law or third-party right.

### 10. Changes to these Terms

We may update these Terms at any time by posting a revised version at
this URL. Continued use of the Site after a change constitutes
acceptance. Material changes will be flagged with an updated "Last
updated" date. [Add a notice mechanism — e.g., banner on Site — before
launch; silent updates to a financial product's terms are a bad look and
some jurisdictions require active notice.]

### 11. Governing law & disputes

[PLACEHOLDER — pick with counsel based on where the entity is
incorporated: e.g., "These Terms are governed by the laws of [X],
without regard to conflict-of-laws principles. Any dispute will be
resolved by binding arbitration in [X], except where prohibited by law."]

### 12. Contact

[CONTACT EMAIL] · [Discord/X handle, if you want a public one]

---

## Privacy Policy

**Last updated: [DATE] — Version [X.X]**

### What we collect

- **Wallet address.** Public by nature (it's on the blockchain);
  associated in our database with your betting history, referral stats,
  streaks, and badges so the leaderboard/portfolio features work.
- **On-chain activity.** Bets, matches, settlements, referrals — all
  already public on Base; we index it (via our own indexer and The Graph)
  to serve it back to you faster than querying the chain directly.
- **Country code, transiently.** The Cloudflare edge (`workers/
  geo-block.ts`) reads your connection's country to enforce the
  Restricted Territory list (§3 above) and passes it to our backend via a
  signed header for a single request. **We do not log or store this
  value** — see `backend/src/index.ts`'s `/api/geo` handler, which reads
  it and returns it without writing to any table. [Verify this remains
  true if the backend implementation changes — this clause is only
  accurate as long as no persistence is added.]
- **Local storage, in your browser only.** A pending referral code
  (`flipthememe:pendingReferrer`, see `frontend/src/lib/referral.ts`) is
  cached in your browser's localStorage so a `?ref=` link you clicked is
  remembered until you place a bet. This never leaves your device except
  as an already-public on-chain `referrer` argument when you actually bet.

### What we do NOT collect

No email, no name, no KYC/identity documents, no phone number. Connecting
a wallet does not create an "account" in the traditional sense — there is
no password, no email verification, nothing to reset.

### Third parties who see some of this

- **Cloudflare** — edge routing and the geo-check (sees your IP, as any
  reverse proxy would).
- **Your RPC provider / wallet** (e.g. Coinbase Wallet, MetaMask) —
  standard for any on-chain interaction, outside FlipTheMeme's control.
- **Pyth Network** — provides price data; does not receive personal data
  from you.
- **The Graph** — indexes public on-chain events; no personal data beyond
  what's already public on-chain.
- **[Hosting provider — Vercel/other, once §"public backend URL" is
  decided]** — standard web-hosting access logs.

### Cookies

The Site does not use tracking/advertising cookies. Wallet-connector
libraries (wagmi/viem) may use localStorage for connection state — this
is functional, not tracking, storage.

### Data retention

On-chain data is permanent and public by the nature of blockchains — we
cannot delete it, and neither can you. Off-chain indexed copies (our
Postgres database) mirror on-chain state and can be reconstructed from
the chain at any time; there is currently no user-initiated deletion
mechanism because there is no private data to delete beyond the localStorage
item above (which you can clear yourself, in your own browser, any time).

### Your rights

Because we hold no off-chain personal data beyond a wallet address (which
is public on-chain regardless of anything we do), most data-subject
rights common in GDPR/CCPA-style frameworks (access, deletion,
portability) are either trivially satisfied (the data is already public
and attributable to you via your own wallet) or not applicable. [Counsel
should confirm whether GDPR/CCPA obligations attach at all given (a) the
Restricted Territory list already excludes the EU/UK/California-adjacent
jurisdictions from *using* the product, and (b) no traditional PII is
collected — but "we block EU IPs" is not automatically a complete GDPR
defense if EU residents can still reach the Site via VPN; discuss.]

### Changes to this policy

Same mechanism as Terms of Service §10.

### Contact

[CONTACT EMAIL]
