// Read-only: recent transactions of a testnet address from the public Blockscout API, grouped by method.
const addr = process.argv[2] ?? '0xbFa008e5A8d46d2014b83551ce6209108416eea4'
const since = process.argv[3] ?? '2026-09-29T00:00:00Z'
const base = `https://explorer.testnet.chain.robinhood.com/api/v2/addresses/${addr}/transactions`
let url = base, pages = 0
const rows = []
while (url && pages < 30) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const j = await res.json()
  for (const t of j.items) rows.push({ ts: t.timestamp, method: t.method ?? (t.to ? 'call' : 'create'), gas: Number(t.gas_used), fee: Number(t.fee?.value ?? 0), status: t.status, to: t.to?.hash, from: t.from?.hash })
  pages++
  if (rows.at(-1).ts < since || !j.next_page_params) break
  url = base + '?' + new URLSearchParams(Object.fromEntries(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])))
  await new Promise(r => setTimeout(r, 300))
}
const mine = rows.filter(r => r.ts >= since && r.from?.toLowerCase() === addr.toLowerCase())
const by = {}
for (const r of mine) { const k = r.method + (r.status === 'ok' ? '' : ' [' + r.status + ']'); (by[k] ??= { n: 0, gas: 0, fee: 0, min: Infinity, max: 0 }); const b = by[k]; b.n++; b.gas += r.gas; b.fee += r.fee; b.min = Math.min(b.min, r.gas); b.max = Math.max(b.max, r.gas) }
console.log('address', addr, 'since', since, 'txs sent', mine.length, 'first', mine.at(-1)?.ts, 'last', mine[0]?.ts)
for (const [k, b] of Object.entries(by).sort((a, b) => b[1].fee - a[1].fee)) console.log(k.padEnd(40), 'n', b.n, 'gas avg', Math.round(b.gas / b.n), 'min', b.min, 'max', b.max, 'fee ETH', (b.fee / 1e18).toFixed(8))
const tot = mine.reduce((a, r) => a + r.fee, 0)
console.log('total fee ETH', (tot / 1e18).toFixed(8))
