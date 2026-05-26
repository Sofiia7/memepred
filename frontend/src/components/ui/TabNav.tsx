import { NavLink } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { MarketsIcon, TrophyIcon, StarIcon, WalletIcon } from './icons'

export function TabNav() {
  const { isConnected } = useAccount()
  const tabs: { to: string; label: string; ico: JSX.Element; end?: boolean }[] = [
    { to: '/', label: 'MARKETS', ico: <MarketsIcon />, end: true },
    { to: '/leaderboard', label: 'LEADERS', ico: <TrophyIcon /> },
    { to: '/genesis', label: 'GENESIS', ico: <StarIcon /> },
  ]
  if (isConnected) tabs.push({ to: '/portfolio', label: 'PORTFOLIO', ico: <WalletIcon /> })

  return (
    <nav className="tabnav" style={{ ['--tabs' as any]: tabs.length }}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'on' : '')}>
          <span className="tab-ico">{t.ico}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
