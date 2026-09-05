// Minimal JSON-RPC client for the Robinhood Chain measurement scripts.
// No dependency on the backend's viem setup: these run standalone, before any
// chain profile exists, and must keep working if the backend is mid-refactor.

export const MAINNET = process.env.RHC_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
export const TESTNET = process.env.RHC_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com'

let nextId = 1

export async function rpc(url, method, params = [], { retries = 4 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
      return body.result
    } catch (err) {
      lastErr = err
      // The public endpoint is rate limited and answers in ~234ms when happy;
      // back off rather than hammering it into a longer refusal.
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  throw lastErr
}

export const call = (url, to, data, block = 'latest') =>
  rpc(url, 'eth_call', [{ to, data }, block])

export const hexToBig = (hex) => BigInt(hex)
export const hexToNum = (hex) => Number(BigInt(hex))
export const toHex = (n) => '0x' + BigInt(n).toString(16)

/** Split a 32-byte-word return blob into words. */
export function words(hex) {
  const body = hex.slice(2)
  const out = []
  for (let i = 0; i + 64 <= body.length; i += 64) out.push('0x' + body.slice(i, i + 64))
  return out
}
