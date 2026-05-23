import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { type Address } from 'viem'
import { useClaim } from '../hooks/useClaim'
import { useReferral } from '../hooks/useReferral'

const API = import.meta.env.VITE_API_URL

interface Bet {
  market_address: Address
  order_id:       string | null
  match_id:       string | null
  direction:      'UP' | 'DOWN'
  amount_usdc:    string
  won:            boolean | null
  payout_usdc:    string | null
  claimed:        boolean
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
  const { claim, pending, error } = useClaim(marketAddress)
  return (
    <button
      className="btn-primary"
      style={{ padding: '4px 10px', fontSize: 11 }}
      disabled={pending}
      onClick={() => claim(orderId)}
      title={error}
    >
      {pending ? '…' : 'Claim'}
    </button>
  )
}

function ReferralPanel() {
  const r = useReferral()
  const refLink = r.myCode && r.myCode !== '0x000000000000'
    ? `${window.location.origin}/?ref=${r.myCode}`
    : null

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 24 }}>
      <h2 style={{ fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase', marginTop: 0, marginBottom: 12 }}>
        Referrals
      </h2>
      <div className="stats-grid" style={{ marginBottom: 12 }}>
        <div className="stat-card">
          <div className="stat-value">{Number(r.myReferralCount ?? 0n)}</div>
          <div className="stat-label">Friends Referred</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${(Number(r.claimableRewards ?? 0n) / 1e6).toFixed(2)}</div>
          <div className="stat-label">Claimable Rewards</div>
        </div>
      </div>

      {refLink ? (
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Your referral link:</div>
          <input
            readOnly
            value={refLink}
            style={{ width: '100%', padding: 8, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      ) : (
        <button className="btn-secondary" onClick={r.generateMyCode} disabled={r.busy}>
          Generate referral code
        </button>
      )}

      {Number(r.claimableRewards ?? 0n) > 0 && (
        <button
          className="btn-primary"
          style={{ marginTop: 10 }}
          onClick={r.claimRewards}
          disabled={r.busy}
        >
          Claim ${(Number(r.claimableRewards ?? 0n) / 1e6).toFixed(2)}
        </button>
      )}
    </div>
  )
}

export function Portfolio() {
  const { address, isConnected } = useAccount()

  const { data: profile, isLoading } = useQuery<Profile>({
    queryKey: ['profile', address],
    queryFn: async () => {
      const res = await fetch(`${API}/api/profile/${address}`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!address,
    refetchInterval: 30_000
  })

  if (!isConnected) {
    return (
      <div className="page" style={{ textAlign: 'center', padding: 80 }}>
        <p style={{ fontSize: 14, color: '#888' }}>Connect your wallet to view your portfolio.</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="page" style={{ textAlign: 'center', padding: 80 }}>
        <p style={{ color: '#666' }}>Loading profile…</p>
      </div>
    )
  }

  const claimable = profile?.recentBets.filter(b =>
    b.won === true && b.order_id !== null && !b.claimed
  ) ?? []

  return (
    <div className="page" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <h1 className="page-title">📊 Portfolio</h1>

      <div className="stats-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Total Bets',  value: profile?.totalBets || 0 },
          { label: 'Won',         value: profile?.wonBets || 0 },
          { label: 'Accuracy',    value: `${profile?.accuracy || 0}%` },
          { label: 'Volume',      value: `$${(profile?.totalVolume || 0).toFixed(0)}` },
          { label: 'Profit',      value: `$${(profile?.profit || 0).toFixed(2)}` },
          { label: 'Streak',      value: `🔥 ${profile?.currentStreak || 0}` },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {claimable.length > 0 && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--accent)', borderRadius: 10, padding: 14, marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, color: 'var(--accent)', textTransform: 'uppercase', marginTop: 0 }}>
            Ready to claim ({claimable.length})
          </h2>
          <table style={{ width: '100%' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', fontSize: 11 }}>
                <th style={{ textAlign: 'left' }}>Coin</th>
                <th style={{ textAlign: 'left' }}>Dir</th>
                <th style={{ textAlign: 'right' }}>Payout</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {claimable.map((b, i) => (
                <tr key={i}>
                  <td>{b.feed_symbol}</td>
                  <td style={{ color: b.direction === 'UP' ? 'var(--accent)' : 'var(--accent2)' }}>
                    {b.direction === 'UP' ? '↑' : '↓'} {b.direction}
                  </td>
                  <td style={{ textAlign: 'right' }}>${parseFloat(b.payout_usdc || '0').toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <ClaimButton marketAddress={b.market_address} orderId={BigInt(b.order_id!)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReferralPanel />

      {profile?.badges && profile.badges.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase' }}>Badges</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {profile.badges.map(b => (
              <div key={b.badge_id} className="stat-card" style={{ padding: '6px 12px' }}>#{b.badge_id}</div>
            ))}
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase' }}>Recent Bets</h2>
      {!profile?.recentBets?.length ? (
        <p style={{ color: 'var(--muted)' }}>No bets yet.</p>
      ) : (
        <table style={{ width: '100%' }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: 11 }}>
              <th style={{ textAlign: 'left' }}>Coin</th>
              <th style={{ textAlign: 'left' }}>Dir</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th style={{ textAlign: 'left' }}>Result</th>
              <th style={{ textAlign: 'right' }}>Payout</th>
            </tr>
          </thead>
          <tbody>
            {profile.recentBets.map((b, i) => (
              <tr key={i}>
                <td>{b.feed_symbol}</td>
                <td style={{ color: b.direction === 'UP' ? 'var(--accent)' : 'var(--accent2)' }}>
                  {b.direction === 'UP' ? '↑' : '↓'} {b.direction}
                </td>
                <td style={{ textAlign: 'right' }}>${parseFloat(b.amount_usdc).toFixed(2)}</td>
                <td>
                  {b.won === null ? 'Pending' :
                   b.claimed     ? 'Claimed' :
                   b.won         ? 'WON · claim →' : 'LOST'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {b.payout_usdc ? `$${parseFloat(b.payout_usdc).toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
