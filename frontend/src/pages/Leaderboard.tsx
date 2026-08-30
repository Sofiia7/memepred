import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScreenTitle } from '../components/ui/AppShell'
import { TrophyIcon } from '../components/ui/icons'
import { shortAddr } from '../lib/symbols'

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

type Period = '24H' | '7D' | '30D' | 'ALL'

const PERIOD_TO_API: Record<Period, string> = {
  '24H': 'daily',
  '7D': 'weekly',
  '30D': 'monthly',
  'ALL': 'alltime',
}

function avatarBg(profit: number): { bg: string; color: string } {
  if (profit < 0) return { bg: '#3b0a1f', color: '#ff3d6e' }
  return { bg: '#0a1a3b', color: '#4d8dff' }
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? '−' : '+'
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

export function Leaderboard() {
  const [period, setPeriod] = useState<Period>('24H')

  const { data, isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ['leaderboard', period],
    queryFn: async () => {
      const res = await fetch(`${API}/api/leaderboard?period=${PERIOD_TO_API[period]}&limit=100`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const top3 = data?.slice(0, 3) ?? []
  const rest = data?.slice(3) ?? []

  return (
    <>
      <ScreenTitle title="Leaderboard" icon={<TrophyIcon color="#ffb547" />} live liveLabel={period} liveColor="var(--up)" />

      <div className="ftabs">
        {(['24H', '7D', '30D', 'ALL'] as Period[]).map((p) => (
          <button key={p} className={'ftab ' + (p === period ? 'on' : '')} onClick={() => setPeriod(p)}>
            {p}
          </button>
        ))}
      </div>

      {isLoading && <div className="empty-state">Loading…</div>}
      {!isLoading && !data?.length && <div className="empty-state">No data yet - be the first</div>}

      {top3.length > 0 && (
        <div className="podium">
          {[top3[1], top3[0], top3[2]].filter(Boolean).map((p) => {
            const av = avatarBg(p.profit)
            return (
              <div key={p.address} className={'pod pod-' + p.rank} style={p.rank === 1 ? { paddingTop: 18, paddingBottom: 18 } : undefined}>
                <div className="rank">{p.rank}</div>
                <div className="av" style={{ background: av.bg, color: av.color, border: `1px solid ${av.color}55` }}>
                  {p.address.slice(2, 3).toUpperCase()}
                </div>
                <div className="nm">{shortAddr(p.address)}</div>
                <div className={'pnl ' + (p.profit < 0 ? 'dn' : '')}>{fmtMoney(p.profit)}</div>
                <div className="wr">{p.accuracy}% WR · {p.totalBets}T</div>
              </div>
            )
          })}
        </div>
      )}

      {rest.length > 0 && <div className="b-title">Rest of the field</div>}

      <div className="lb-list">
        {rest.map((p) => {
          const av = avatarBg(p.profit)
          return (
            <div key={p.address} className="lb-row">
              <div className="lb-rank">#{p.rank}</div>
              <div className="lb-user">
                <div className="lb-av" style={{ background: av.bg, color: av.color, border: `1px solid ${av.color}55` }}>
                  {p.address.slice(2, 3).toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="lb-name">{shortAddr(p.address)}</div>
                  <div className="lb-sub">{p.totalBets} bets · 🔥 {p.streak}</div>
                </div>
              </div>
              <div className="lb-wr">{p.accuracy}%</div>
              <div className={'lb-pnl ' + (p.profit < 0 ? 'dn' : '')}>{fmtMoney(p.profit)}</div>
            </div>
          )
        })}
      </div>

      <div style={{ height: 24 }} />
    </>
  )
}
