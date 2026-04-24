import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

interface LeaderboardEntry {
  rank:      number
  address:   string
  totalBets: number
  wonBets:   number
  accuracy:  number
  volume:    number
  profit:    number
  streak:    number
}

export function Leaderboard() {
  const { data, isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ['leaderboard'],
    queryFn: async () => {
      const res = await fetch(`${API}/api/leaderboard?period=weekly&limit=100`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 60_000
  })

  return (
    <div className="page">
      <h1 className="page-title">🏆 Leaderboard</h1>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>Loading...</div>
      ) : !data?.length ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
          No leaderboard data yet. Start trading!
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="lb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th>Bets</th>
                <th>Won</th>
                <th>Accuracy</th>
                <th>Volume</th>
                <th>Profit</th>
                <th>Streak</th>
              </tr>
            </thead>
            <tbody>
              {data.map(e => (
                <tr key={e.address}>
                  <td style={{ fontWeight: 800, color: e.rank <= 3 ? '#ffdd00' : '#888' }}>
                    {e.rank}
                  </td>
                  <td style={{ fontFamily: 'JetBrains Mono', fontSize: 10 }}>
                    {e.address.slice(0,6)}...{e.address.slice(-4)}
                  </td>
                  <td>{e.totalBets}</td>
                  <td style={{ color: '#00ff88' }}>{e.wonBets}</td>
                  <td style={{ fontWeight: 700, color: e.accuracy >= 60 ? '#00ff88' : '#ff3355' }}>
                    {e.accuracy}%
                  </td>
                  <td>${e.volume.toFixed(0)}</td>
                  <td style={{ color: e.profit >= 0 ? '#00ff88' : '#ff3355', fontWeight: 700 }}>
                    {e.profit >= 0 ? '+' : ''}{e.profit.toFixed(2)}
                  </td>
                  <td>🔥 {e.streak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
