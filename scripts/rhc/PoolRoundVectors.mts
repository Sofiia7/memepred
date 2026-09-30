/**
 * Reference vectors for contracts/src/PoolRounds.sol, computed by the reference model itself.
 *
 * Run from the repository root (no network, keys or transactions):
 *   node scripts/rhc/PoolRoundVectors.mts           writes contracts/test/PoolRoundVectors.t.sol
 *   node scripts/rhc/PoolRoundVectors.mts --check   exits 1 if that file is not what this run would write
 *
 * The model is NOT copied here. The script reads scripts/rhc/positive-ev.mts, cuts it before its first
 * top-level statement that runs anything (`const tests = selfTest()`), strips the TypeScript types with
 * node:module stripTypeScriptTypes and imports the result as a module. It then runs the reference's own
 * selfTest() on that code, so the functions used below are the ones whose numbers POSITIVE-EV.md quotes.
 * The sha256 of positive-ev.mts goes into the generated file: an edited reference makes --check fail.
 *
 * Books are settled at side cap 1 (the design, accepted = min(UP, DOWN)) and at cap 4, the cap is part of
 * each vector. Output: several small forge test contracts, one test per vector, each vector abi-encoded as
 * uint256 words (a single contract with all of them would exceed the 24 576-byte code size limit forge
 * enforces). The check itself lives in contracts/test/PoolRoundVectorsBase.sol.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REF = new URL('./positive-ev.mts', import.meta.url)
const OUT = new URL('../../contracts/test/PoolRoundVectors.t.sol', import.meta.url)
const RANDOM_BOOKS_PER_CAP = 40 // at cap 1 (the design) and again at cap 4
const PER_CONTRACT = 10

// ── load the reference model's own code ──────────────────────────────────────
const source = readFileSync(REF, 'utf8')
const sourceHash = createHash('sha256').update(source).digest('hex')
const cut = source.indexOf('\nconst tests = selfTest()')
assert(cut > 0, 'positive-ev.mts no longer has `const tests = selfTest()`: update the cut point')
const js = stripTypeScriptTypes(source.slice(0, cut), { mode: 'strip' })
  + '\nexport { clear, settle, fees, policy, eth, selfTest }\n'
const dir = mkdtempSync(join(tmpdir(), 'poolround-vectors-'))
let model
try {
  const file = join(dir, 'positive-ev-model.mjs')
  writeFileSync(file, js)
  model = await import(pathToFileURL(file).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
const { clear, settle, policy, eth, selfTest } = model
const self = selfTest() // throws unless 0.098 / 0.0495 / 0.3 / 0.196 / 0.32 / 0.001402 ... all hold
assert.equal(self.outcomeChecks, 80_000)

// ── books ────────────────────────────────────────────────────────────────────
type Side = 'up' | 'down'
type Outcome = Side | 'tie' | 'oracle-refund'
type Ticket = { side: Side; stake: bigint }
type Book = { label: string; gasGwei: number; ratio: bigint; outcome: Outcome; tickets: Ticket[] }

const books: Book[] = []
// selfTest() books first, with the outcomes it asserts on
const bal = [{ side: 'up', stake: eth('0.05') }, { side: 'down', stake: eth('0.05') }] as Ticket[]
for (const outcome of ['up', 'down', 'tie', 'oracle-refund'] as Outcome[]) {
  books.push({ label: `selfTest balanced 0.05/0.05, ${outcome}, cap 1`, gasGwei: 0.398, ratio: 1n, outcome, tickets: bal })
}
books.push({ label: 'selfTest skew 0.4/0.1, down, cap 1', gasGwei: 0.398, ratio: 1n, outcome: 'down',
  tickets: [{ side: 'up', stake: eth('0.4') }, { side: 'down', stake: eth('0.1') }] })
books.push({ label: 'selfTest skew 0.4/0.02, down, cap 4', gasGwei: 0.398, ratio: 4n, outcome: 'down',
  tickets: [{ side: 'up', stake: eth('0.4') }, { side: 'down', stake: eth('0.02') }] })
books.push({ label: 'selfTest under 0.005/0.005, up, cap 1', gasGwei: 0.398, ratio: 1n, outcome: 'up',
  tickets: [{ side: 'up', stake: eth('0.005') }, { side: 'down', stake: eth('0.005') }] })
books.push({ label: 'selfTest one-sided 1, down, cap 1', gasGwei: 0.398, ratio: 1n, outcome: 'down',
  tickets: [{ side: 'up', stake: eth('1') }] })

// Deterministic random books: same xorshift as selfTest(), different seed.
let seed = 0x0bad5eed
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
const outcomes: Outcome[] = ['up', 'down', 'tie', 'oracle-refund']
const gasLevels = [0.020142, 0.069692, 0.398, 1.039]
for (let v = 0; v < 2 * RANDOM_BOOKS_PER_CAP; v++) {
  const ratio = v < RANDOM_BOOKS_PER_CAP ? 1n : 4n
  const n = 1 + random() % 10
  const skewSide: Side | null = random() % 4 === 0 ? (random() % 2 ? 'up' : 'down') : null
  const tickets: Ticket[] = Array.from({ length: n }, () => {
    const side: Side = random() % 2 ? 'up' : 'down'
    const units = BigInt(1 + random() % 40) * (side === skewSide ? 8n : 1n)
    return { side, stake: units * eth('0.005') + BigInt(random() % 1000) }
  })
  books.push({ label: `random ${v}, cap ${ratio}`, gasGwei: gasLevels[random() % 4], ratio, outcome: outcomes[v % 4], tickets })
}

// ── run the model ────────────────────────────────────────────────────────────
const OUTCOME_CODE: Record<Outcome, bigint> = { up: 1n, down: 2n, tie: 3n, 'oracle-refund': 4n }
const TWO_127 = 1n << 127n
const TWO_128 = 1n << 128n
let activeCount = 0
const encoded = books.map((b) => {
  const p = { ...policy(b.gasGwei), maxSideRatio: b.ratio }
  const c = clear(b.tickets, p)
  const r = settle(b.tickets, b.outcome, p, c.active ? p.costAllowance : 0n)
  if (r.active) activeCount++
  assert(b.tickets.length < 256)
  const words: bigint[] = [
    BigInt(b.tickets.length) | (OUTCOME_CODE[b.outcome] << 8n) | ((r.active ? 1n : 0n) << 16n) | (b.ratio << 24n),
    p.costAllowance, p.minimumBank, r.bank, r.grossFee, r.referral, r.treasury, r.dust,
  ]
  b.tickets.forEach((t, i) => {
    assert(t.stake < TWO_127 && r.payouts[i] < TWO_128)
    words.push(((t.side === 'up' ? 1n : 0n) << 255n) | (t.stake << 128n) | r.payouts[i])
  })
  return { label: b.label, active: r.active, words }
})

// abi.encode(uint256[]): offset, length, words
const abiHex = (words: bigint[]) => [0x20n, BigInt(words.length), ...words]
  .map((w) => w.toString(16).padStart(64, '0')).join('')

// ── emit forge tests ─────────────────────────────────────────────────────────
const lines: string[] = []
lines.push('// SPDX-License-Identifier: MIT')
lines.push('pragma solidity ^0.8.24;')
lines.push('')
lines.push('// GENERATED by scripts/rhc/PoolRoundVectors.mts - do not edit by hand, rerun the script.')
lines.push(`// Reference: scripts/rhc/positive-ev.mts, sha256 ${sourceHash}.`)
lines.push(`// ${books.length} books (${activeCount} activated, ${books.length - activeCount} not; cap 1 and cap 4), each settled by the`)
lines.push('// reference and replayed through PoolRounds by PoolRoundVectorsBase._check.')
lines.push('')
lines.push('import "./PoolRoundVectorsBase.sol";')
for (let c = 0; c * PER_CONTRACT < encoded.length; c++) {
  lines.push('')
  lines.push(`contract PoolRoundVectors${c}Test is PoolRoundVectorsBase {`)
  const chunk = encoded.slice(c * PER_CONTRACT, (c + 1) * PER_CONTRACT)
  chunk.forEach((e, k) => {
    const i = c * PER_CONTRACT + k
    lines.push(`    /// ${e.label}${e.active ? '' : ' (not activated)'}`)
    lines.push(`    function test_Vector${String(i).padStart(2, '0')}() public {`)
    // the layout forge fmt gives a call with one long hex argument, so the file stays fmt-clean
    lines.push('        _check(')
    lines.push(`            hex"${abiHex(e.words)}"`)
    lines.push('        );')
    lines.push('    }')
    if (k < chunk.length - 1) lines.push('')
  })
  lines.push('}')
}
const text = lines.join('\n') + '\n'

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n')
  if (current !== text) {
    console.error('contracts/test/PoolRoundVectors.t.sol is stale: rerun node scripts/rhc/PoolRoundVectors.mts')
    process.exit(1)
  }
  console.log(`up to date: ${books.length} vectors, reference sha256 ${sourceHash}`)
} else {
  writeFileSync(OUT, text)
  console.log(`reference selfTest ok (${self.outcomeChecks} outcome checks), sha256 ${sourceHash}`)
  console.log(`wrote contracts/test/PoolRoundVectors.t.sol: ${books.length} vectors, ${activeCount} activated`)
}
