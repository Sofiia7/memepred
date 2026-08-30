import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { type Address } from 'viem'
import { useClaim } from '../hooks/useClaim'
import { useReferral } from '../hooks/useReferral'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { BadgeGrid } from '../components/BadgeGrid'
import { WalletIcon, Chev } from '../components/ui/icons'
import { symbolMeta, shortAddr } from '../lib/symbols'

const API = import.meta.env.VITE_API_URL

interface Bet {
  market_address: Address
  order_id:       string | null
  match_id:       string | null
  direction:      'UP' | 'DOWN'
  amount_usdc:    string
  /** null while the bet is still running; a real boolean once it has settled. */
  won:            boolean | null
  payout_usdc:    string | null
  claimed:        boolean
  status:         'PENDING' | 'MATCHED' | 'SETTLED' | 'CLAIMED' | 'REFUNDED'
  placed_at:      string
  settled_at:     string | null
  feed_symbol:    string
}

interface Profile {
  address:       string
  totalBets:     number
  wonBets:       number
  accuracy:      number
  totalVolume:   number
  profit:        number
  currentStreak: number
  maxStreak:     number
  badges:        { badge_id: number; minted_at: string }[]
  recentBets:    Bet[]
}

function ClaimButton({ marketAddress, orderId }: { marketAddress: Address; orderId: bigint }) {
  const { claim, pending } = useClaim(marketAddress)
  return (
    <button
      className="cta"
      style={{ padding: '6px 10px', fontSize: 10, height: 'auto', width: 'auto' }}
      disabled={pending}
      onClick={(e) => {
        // Row itself is a Link to /order/...; claiming from here shouldn't navigate.
        e.preventDefault()
        e.stopPropagation()
        claim(orderId)
      }}
    >
      {pending ? <span className="spinner" /> : null}
      CLAIM
    </button>
  )
}

function BetRow({ bet }: { bet: Bet }) {
  const meta = symbolMeta(bet.feed_symbol)
  const isUp = bet.direction === 'UP'
  const amount = parseFloat(bet.amount_usdc)
  const payout = bet.payout_usdc ? parseFloat(bet.payout_usdc) : null
  // Drive this off the order's own status rather than inferring it from the
  // payout: a settled winner has no payout recorded until it is claimed, so the
  // old chain (won === null ? … : won ? 'WON' : 'LOST') rendered every live and
  // every unclaimed-winning bet as LOST, and hid the claim button behind a
  // condition that could only become true after the money had already been
  // taken. REFUNDED is its own outcome - the stake came back, nobody lost.
  const status =
    bet.status === 'REFUNDED' ? 'REFUNDED' :
    bet.status === 'CLAIMED'  ? 'CLAIMED'  :
    bet.won === null          ? 'PENDING'  :
    bet.won                   ? 'WON'      : 'LOST'
  const canClaim = bet.status === 'SETTLED' && bet.won === true && !bet.claimed && bet.order_id

  const rowContent = (
    <>
      <div className={'coin-icon ' + meta.iconClass} style={{ width: 26, height: 26, fontSize: 10 }}>{meta.glyph}</div>
      <div style={{ minWidth: 0 }}>
        <div className="lb-name">
          <span className={'pick-pill ' + (isUp ? 'up' : 'dn')} style={{ marginRight: 6, padding: '2px 6px', fontSize: 9 }}>
            <Chev dir={isUp ? 'up' : 'down'} /> {bet.direction}
          </span>
          {bet.feed_symbol} · ${amount.toFixed(2)}
        </div>
        <div className="lb-sub">{status}{payout !== null ? ` · payout $${payout.toFixed(2)}` : ''}</div>
      </div>
      {canClaim ? (
        <ClaimButton marketAddress={bet.market_address} orderId={BigInt(bet.order_id!)} />
      ) : (
        <span />
      )}
      <div className={'lb-pnl ' + (bet.won === false ? 'dn' : '')}>
        {payout !== null ? `$${payout.toFixed(2)}` : '-'}
      </div>
    </>
  )

  // Every bet with an on-chain order_id has a status page - link to it so
  // "pending" bets are actually trackable instead of a dead-end list row.
  if (bet.order_id) {
    return (
      <Link
        to={`/order/${bet.market_address}/${bet.order_id}`}
        className="lb-row"
        style={{ gridTemplateColumns: '32px 1fr auto auto', textDecoration: 'none', color: 'inherit' }}
      >
        {rowContent}
      </Link>
    )
  }

  return (
    <div className="lb-row" style={{ gridTemplateColumns: '32px 1fr auto auto' }}>
      {rowContent}
    </div>
  )
}

function ReferralPanel() {
  const r = useReferral()
  const refLink = r.myCode && r.myCode !== '0x000000000000'
    ? `${window.location.origin}/?ref=${r.myCode}`
    : null
  const claimable = Number(r.claimableRewards ?? 0n) / 1e6

  return (
    <>
      <div className="b-title" style={{ justifyContent: 'space-between' }}>
        Referrals
        <Link to="/refer" style={{ fontSize: 10, color: 'var(--base-blue-2)', textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>
          View all →
        </Link>
      </div>
      <StatStrip
        items={[
          { k: 'Friends Referred', v: String(Number(r.myReferralCount ?? 0n)) },
          { k: 'Claimable', v: `$${claimable.toFixed(2)}`, tone: claimable > 0 ? 'up' : undefined },
        ]}
      />
      {refLink ? (
        <div className="stake-input" style={{ marginBottom: 10 }}>
          <span className="ccy" style={{ marginRight: 6, fontSize: 10 }}>LINK</span>
          <input readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 10 }} />
        </div>
      ) : (
        <button className="cta" style={{ marginBottom: 10 }} onClick={r.generateMyCode} disabled={r.busy}>
          <span className="basesq" />
          GENERATE CODE
        </button>
      )}
      {claimable > 0 && (
        <button className="cta" style={{ marginBottom: 14 }} onClick={r.claimRewards} disabled={r.busy}>
          {r.busy ? <span className="spinner" /> : <span className="basesq" />}
          CLAIM ${claimable.toFixed(2)}
        </button>
      )}
    </>
  )
}

export function Portfolio() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()

  const { data: profile, isLoading, isError, refetch } = useQuery<Profile>({
    queryKey: ['profile', address],
    queryFn: async () => {
      const res = await fetch(`${API}/api/profile/${address}`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!address,
    refetchInterval: 30_000,
    retry: 2,
  })

  if (!isConnected) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state" style={{ marginBottom: 16 }}>Connect wallet to view your stats</div>
        <button className="cta" onClick={connectWallet}>
          <span className="basesq" />
          CONNECT WALLET
        </button>
      </>
    )
  }

  if (isError) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state">Couldn't load your profile. The API may be temporarily unavailable.</div>
        <button className="cta" onClick={() => refetch()}>
          <span className="basesq" />
          RETRY
        </button>
      </>
    )
  }

  if (isLoading || !profile) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state">Loading profile…</div>
      </>
    )
  }

  const ownedBadgeIds = new Set((profile.badges ?? []).map((b) => b.badge_id))
  // Same condition as BetRow's canClaim - an order is claimable only while it
  // is SETTLED. Without the status check an already-claimed bet reappeared here
  // forever, because the API never sent `claimed` and `!undefined` is true.
  const claimable = profile.recentBets.filter(
    (b) => b.status === 'SETTLED' && b.won === true && b.order_id && !b.claimed,
  )

  return (
    <>
      <ScreenTitle title="Portfolio" icon={<WalletIcon />} live liveLabel={shortAddr(address)} liveColor="var(--up)" />

      <StatStrip
        items={[
          { k: 'Profit', v: `${profile.profit >= 0 ? '+' : '−'}$${Math.abs(profile.profit).toFixed(2)}`, tone: profile.profit >= 0 ? 'up' : 'dn' },
          { k: 'Accuracy', v: `${profile.accuracy}%`, u: `${profile.wonBets}/${profile.totalBets}` },
        ]}
      />
      <StatStrip
        items={[
          { k: 'Volume', v: `$${profile.totalVolume.toFixed(0)}`, u: 'USDC' },
          { k: 'Streak', v: `🔥 ${profile.currentStreak}`, u: `max ${profile.maxStreak}` },
        ]}
      />

      {claimable.length > 0 && (
        <>
          <div className="b-title">Ready to claim ({claimable.length})</div>
          <div className="lb-list" style={{ marginBottom: 14 }}>
            {claimable.map((b, i) => <BetRow key={i} bet={b} />)}
          </div>
        </>
      )}

      <ReferralPanel />

      <div className="b-title">Badges</div>
      <BadgeGrid ownedIds={ownedBadgeIds} />

      <div className="b-title" style={{ marginTop: 16 }}>Recent bets</div>
      {profile.recentBets.length === 0 ? (
        <div className="empty-state">No bets yet</div>
      ) : (
        <div className="lb-list">
          {profile.recentBets.map((b, i) => <BetRow key={i} bet={b} />)}
        </div>
      )}

      <div style={{ height: 24 }} />
    </>
  )
}
