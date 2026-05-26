import type { ReactNode } from 'react'
import { AppHead } from './AppHead'
import { TabNav } from './TabNav'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <AppHead />
      <div className="app-body">{children}</div>
      <TabNav />
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
