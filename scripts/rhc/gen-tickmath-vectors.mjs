// Generates contracts/test/fixtures/TickMathVectors.sol from a pool scan.
//
// Every Uniswap v3 pool publishes slot0().tick and slot0().sqrtPriceX96
// together, both produced by Uniswap's own deployed code. That makes each live
// pool a free test vector for our vendored TickMath: the invariant
//
//     getSqrtRatioAtTick(tick) <= sqrtPriceX96 < getSqrtRatioAtTick(tick + 1)
//
// holds by construction on chain, so a transcription error in any of the twenty
// magic constants breaks it. This is worth more than hand-written expectations,
// which would only prove the copy agrees with whoever wrote them down.
//
// Usage: node scripts/rhc/gen-tickmath-vectors.mjs [--pools FILE] [--out FILE]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const poolsFile = arg('pools', 'docs/rhc/measurements/pools-24h.json')
const out = arg('out', 'contracts/test/fixtures/TickMathVectors.sol')

const data = JSON.parse(readFileSync(poolsFile, 'utf8'))

// One vector per distinct tick: pools cluster hard on a few initialisation
// ticks, and 200 copies of the same tick prove nothing the first did not.
const byTick = new Map()
for (const p of data.pools) {
  if (!p.sqrtPriceX96 || p.sqrtPriceX96 === '0') continue
  if (!byTick.has(p.tick)) byTick.set(p.tick, p)
}
const vectors = [...byTick.values()].sort((a, b) => a.tick - b.tick)

const lines = vectors.map((v) => `        _v(${v.tick}, ${v.sqrtPriceX96}); // ${v.symbol ?? '?'} ${v.pool}`)

const sol = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * GENERATED - do not edit by hand.
 * Regenerate: node scripts/rhc/gen-tickmath-vectors.mjs
 *
 * ${vectors.length} (tick, sqrtPriceX96) pairs read from live Uniswap v3 pools on
 * Robinhood Chain (chainId 4663), scan of blocks ${data.fromBlock}-${data.toBlock}.
 * Tick range ${vectors[0].tick} to ${vectors[vectors.length - 1].tick}, i.e. the full
 * usable range including MIN_TICK.
 *
 * Each pair was produced by Uniswap's own deployed code, so it is an
 * independent check on our vendored TickMath rather than a restatement of it.
 */
abstract contract TickMathVectors {
    int24[] internal vecTick;
    uint160[] internal vecSqrt;

    function _v(int24 tick, uint160 sqrtPriceX96) private {
        vecTick.push(tick);
        vecSqrt.push(sqrtPriceX96);
    }

    function _loadVectors() internal {
${lines.join('\n')}
    }
}
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, sol)
console.log(`wrote ${vectors.length} vectors -> ${out}`)
