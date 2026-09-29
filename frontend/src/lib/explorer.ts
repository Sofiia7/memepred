import { TARGET_CHAIN } from './chain'

/** The block explorer of the chain this build targets, without a trailing slash. */
export function explorerBase(): string | undefined {
  const url = TARGET_CHAIN.blockExplorers?.default.url
  return url ? url.replace(/\/+$/, '') : undefined
}

export function explorerTxUrl(hash: string): string | undefined {
  const base = explorerBase()
  return base ? `${base}/tx/${hash}` : undefined
}

export function explorerAddressUrl(address: string): string | undefined {
  const base = explorerBase()
  return base ? `${base}/address/${address}` : undefined
}
