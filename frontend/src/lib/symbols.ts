export interface SymbolMeta {
  iconClass: string
  glyph: string
  name: string
}

const META: Record<string, SymbolMeta> = {
  DOGE: { iconClass: 'icon-doge', glyph: 'Ð', name: 'dogecoin' },
  PEPE: { iconClass: 'icon-pepe', glyph: 'P', name: 'pepe' },
  SHIB: { iconClass: 'icon-shib', glyph: 'S', name: 'shiba inu' },
  WIF:  { iconClass: 'icon-wif',  glyph: 'W', name: 'dogwifhat' },
}

export function symbolMeta(sym: string): SymbolMeta {
  const key = sym.toUpperCase()
  return META[key] ?? { iconClass: 'icon-default', glyph: key[0] ?? '?', name: sym.toLowerCase() }
}

export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return '-'
  if (p < 0.001) return p.toFixed(8)
  if (p < 1) return p.toFixed(4)
  return p.toFixed(2)
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return `${h}h`
}

export function shortAddr(a?: string | null): string {
  if (!a) return ''
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}

export function countdown(closeTime: number): string {
  const secs = Math.max(0, closeTime - Math.floor(Date.now() / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
