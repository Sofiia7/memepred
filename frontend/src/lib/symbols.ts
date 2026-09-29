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

/**
 * Recovers the pool address a market's feedId encodes on IS_POOL_BACKED
 * chains: PoolMarketFactory.feedIdFor computes bytes32(uint256(uint160(pool))),
 * i.e. the 20-byte address left-padded with zeros to 32 bytes. Meaningless on
 * Base, where feedId is a RedStone feed id rather than an encoded address.
 */
export function feedIdToAddress(feedId: string): string {
  return '0x' + feedId.slice(-40)
}

/**
 * The inverse of feedIdToAddress: a pool address as the 32-byte, lowercase,
 * left-padded feedId its markets are stored under. Mirrors the SQL in
 * backend/src/routes/pools.ts (`'0x' || lpad(substr(pool_address, 3), 64, '0')`),
 * which is how the pools API joins a pool to its markets - and why that API
 * only returns durations, leaving the market address for the client to look up.
 */
export function addressToFeedId(address: string): string {
  return '0x' + address.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

/**
 * A market with no close time. On Robinhood Chain a market is created once and
 * lives forever: each match settles `duration` after it was made, and there is
 * no round to count down to. The API serves that as null (and older builds as
 * 0, the epoch), which a countdown renders as 00:00 on every card.
 */
export function isContinuousMarket(closeTime: number | null | undefined): boolean {
  return !closeTime
}

export function countdown(closeTime: number): string {
  const secs = Math.max(0, closeTime - Math.floor(Date.now() / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
