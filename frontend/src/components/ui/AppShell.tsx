import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AppHead } from './AppHead'
import { TabNav } from './TabNav'
import { WalletPicker } from './WalletPicker'
import { NetworkPill } from './NetworkPill'
import { WrongNetworkBanner, DeploymentBanner } from './NetworkStatus'
import { RiskStrip } from '../RiskDisclosure'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <AppHead />
      <NetworkPill />
      <RiskStrip />
      <WrongNetworkBanner />
      <DeploymentBanner />
      <div className="app-body">
        {children}
        <div className="app-foot">
          <Link to="/how-it-works">How it works</Link>
          <span>·</span>
          <Link to="/terms">Terms</Link>
        </div>
      </div>
      <TabNav />
      <WalletPicker />
    </div>
  )
}

export function ScreenTitle({
  title,
  icon,
  live,
  liveLabel,
  liveColor,
}: {
  title: string
  icon?: ReactNode
  live?: boolean
  liveLabel?: string
  liveColor?: string
}) {
  return (
    <div className="screen-title">
      {icon && <div className="ico">{icon}</div>}
      <h2>{title}</h2>
      {live && (
        <span className="live">
          <span className="dot" style={liveColor ? { background: liveColor } : undefined} />
          {liveLabel ?? 'live'}
        </span>
      )}
    </div>
  )
}

export function StatStrip({ items }: { items: { k: string; v: ReactNode; u?: string; tone?: 'up' | 'dn' }[] }) {
  return (
    <div className="stats">
      {items.map((s, i) => (
        <div key={i} className="stat">
          <div className="k">{s.k}</div>
          <div className={'v' + (s.tone ? ' ' + s.tone : '')}>
            {s.v}
            {s.u && <span className="u">{s.u}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
