import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

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
  recentBets:    any[]
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
        <p style={{ color: '#666' }}>Loading profile...</p>
      </div>
    )
  }

  return (
    <div className="page">
      <h1 className="page-title">📊 Portfolio</h1>

      {/* Stats Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 12,
        marginBottom: 24
      }}>
        {[
          { label: 'Total Bets', value: profile?.totalBets || 0 },
          { label: 'Won', value: profile?.wonBets || 0, color: '#00ff88' },
          { label: 'Accuracy', value: `${profile?.accuracy || 0}%`, color: (profile?.accuracy || 0) >= 50 ? '#00ff88' : '#ff3355' },
          { label: 'Volume', value: `$${(profile?.totalVolume || 0).toFixed(0)}` },
          { label: 'Profit', value: `$${(profile?.profit || 0).toFixed(2)}`, color: (profile?.profit || 0) >= 0 ? '#00ff88' : '#ff3355' },
          { label: 'Streak', value: `🔥 ${profile?.currentStreak || 0}` },
        ].map(s => (
          <div key={s.label} style={{
            background: '#111',
            border: '1px solid #2a2a2a',
            borderRadius: 8,
            padding: 14,
            textAlign: 'center'
          }}>
            <div style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: s.color || '#e0e0e0' }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Badges */}
      {profile?.badges && profile.badges.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: '#888' }}>BADGES</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {profile.badges.map(b => (
              <div key={b.badge_id} style={{
                background: '#1a1a1a',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 10,
                fontWeight: 700,
              }}>
                Badge #{b.badge_id}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Bets */}
      <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: '#888' }}>RECENT BETS</h2>
      {!profile?.recentBets?.length ? (
        <p style={{ color: '#666', fontSize: 12 }}>No bets yet.</p>
      ) : (
        <table className="lb-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Dir</th>
              <th>Amount</th>
              <th>Result</th>
              <th>Payout</th>
            </tr>
          </thead>
          <tbody>
            {profile.recentBets.map((b, i) => (
              <tr key={i}>
                <td>{b.feed_symbol}</td>
                <td style={{ color: b.direction === 'UP' ? '#00ff88' : '#ff3355', fontWeight: 700 }}>
                  {b.direction === 'UP' ? '↑' : '↓'} {b.direction}
                </td>
                <td>${parseFloat(b.amount_usdc).toFixed(2)}</td>
                <td style={{ color: b.won ? '#00ff88' : b.won === false ? '#ff3355' : '#888' }}>
                  {b.won === null ? 'Pending' : b.won ? 'WON' : 'LOST'}
                </td>
                <td>{b.payout_usdc ? `$${parseFloat(b.payout_usdc).toFixed(2)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
