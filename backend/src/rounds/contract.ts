/**
 * PoolRounds (interface v3) as the keeper sees it: the ABI subset it calls, the
 * events that say a round exists, how the contract's deadlines map onto the
 * keeper's, the hard deadlines that follow from the pool's observation ring,
 * where the deployment lives, and the bit layout of a round id.
 *
 * ONE file on purpose. The contract (contracts/src/PoolRounds.sol, interface in
 * docs/rhc/ROUNDS-CONTRACT.md, "Интерфейс v3") is unaudited in this form and may
 * still change; a change is made here and nowhere else:
 *
 *   POOL_ROUNDS_ABI        the functions, events and errors used
 *   DISCOVERY_EVENTS       every event that names a round which exists
 *   CLOSING_EVENTS         the events after which a round owes nothing
 *   POOL_EVENTS            the events that list and delist a pool
 *   timesFromContract      the contract's Times struct -> the keeper's deadlines
 *   checkDeadlines         keeperDeadlines(roundId) -> the hard deadlines
 *   checkRoundView         the contract's RoundView struct -> the keeper's state
 *
 * No deadline is computed in the keeper: openAt, closeAt, strikeStart,
 * strikeEnd and settleAt come from roundTimes(roundId) or roundView(roundId),
 * and the hard deadlines of fixStrike and settle from keeperDeadlines(roundId).
 * Nor is the listing gate: whether a pool is below it is asked of the contract
 * by a dry run of delistIfBelowGate(pool).
 *
 * contract.test.ts compares every ABI item against the forge artifact
 * (contracts/out/PoolRounds.sol/PoolRounds.json) whenever that artifact exists,
 * so a renamed field or a reordered struct fails a test instead of decoding
 * into the wrong numbers. That matters more than usual here: roundView returns
 * a static struct, and a static struct decoded with a shorter or reordered ABI
 * does not fail, it quietly shifts every field (the lesson from the old RHC
 * deployments, whose getOrder grew from 11 to 13 words). So the keeper also
 * cross-checks every decoded view (checkRoundView) and refuses to act on a
 * contract whose answers do not line up.
 */
import { getAddress, isAddress, type Address } from 'viem'

// ── ABI ───────────────────────────────────────────────────────────────
// Generated from the v3 artifact of 2026-09-30 04:14 (after the re-audit:
// depth rule, keeperDeadlines, delistIfBelowGate; internalType dropped), then
// checked by contract.test.ts. Only what the keeper uses.

const TIMES_COMPONENTS = [
  { name: 'openAt', type: 'uint256' },
  { name: 'closeAt', type: 'uint256' },
  { name: 'strikeStart', type: 'uint256' },
  { name: 'strikeEnd', type: 'uint256' },
  { name: 'settleAt', type: 'uint256' },
] as const

export const POOL_ROUNDS_ABI = [
  // ── a constant, read once per process ──
  { type: 'function', name: 'SETTLE_GRACE', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },

  // ── the hard deadlines of fixStrike and settle, per round ──
  {
    type: 'function', name: 'keeperDeadlines', stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint256' }],
    outputs: [{ name: 'fixStrikeBy', type: 'uint256' }, { name: 'settleBy', type: 'uint256' }],
  },

  // ── the listing gate, for health ──
  { type: 'function', name: 'gateDepth', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'wethDepth', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },

  // ── state ──
  {
    type: 'function', name: 'roundTimes', stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint256' }],
    outputs: [{ name: 't', type: 'tuple', components: TIMES_COMPONENTS }],
  },
  {
    type: 'function', name: 'roundView', stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint256' }],
    outputs: [{
      name: 'v', type: 'tuple',
      components: [
        { name: 'pool', type: 'address' },
        { name: 'duration', type: 'uint256' },
        { name: 'index', type: 'uint256' },
        { name: 'times', type: 'tuple', components: TIMES_COMPONENTS },
        { name: 'committed', type: 'uint256' },
        { name: 'rawUp', type: 'uint256' },
        { name: 'rawDown', type: 'uint256' },
        { name: 'acceptedUp', type: 'uint256' },
        { name: 'acceptedDown', type: 'uint256' },
        { name: 'bank', type: 'uint256' },
        { name: 'minBank', type: 'uint256' },
        { name: 'costAllowance', type: 'uint256' },
        { name: 'bookClosed', type: 'bool' },
        { name: 'activated', type: 'bool' },
        { name: 'strikeFixed', type: 'bool' },
        { name: 'outcome', type: 'uint8' },
        { name: 'entryTick', type: 'int24' },
        { name: 'exitTick', type: 'int24' },
      ],
    }],
  },
  { type: 'function', name: 'feesAccrued', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },

  // ── the keeper's four writes ──
  { type: 'function', name: 'fixStrike', stateMutability: 'nonpayable', inputs: [{ name: 'roundId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'roundId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawFees', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'delistIfBelowGate', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'address' }], outputs: [] },

  // ── events: discovery reads the round and pool events; receipts StrikeFixed, RoundSettled, FeesWithdrawn, PoolBelowGate ──
  {
    type: 'event', name: 'RoundOpened', anonymous: false,
    inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'pool', type: 'address', indexed: true },
      { name: 'duration', type: 'uint256', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
      { name: 'closeAt', type: 'uint256', indexed: false },
      { name: 'minBank', type: 'uint256', indexed: false },
      { name: 'costAllowance', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Bet', anonymous: false,
    inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'side', type: 'uint8', indexed: false },
      { name: 'stake', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'StrikeFixed', anonymous: false,
    inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'entryTick', type: 'int24', indexed: false },
      { name: 'entryPrice', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RoundSettled', anonymous: false,
    inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'reason', type: 'uint8', indexed: false },
      { name: 'entryPrice', type: 'uint256', indexed: false },
      { name: 'exitPrice', type: 'uint256', indexed: false },
      { name: 'bank', type: 'uint256', indexed: false },
      { name: 'grossFee', type: 'uint256', indexed: false },
      { name: 'referralPot', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'FeesWithdrawn', anonymous: false,
    inputs: [
      { name: 'treasury', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PoolListed', anonymous: false,
    inputs: [
      { name: 'pool', type: 'address', indexed: true },
      { name: 'wethIsToken0', type: 'bool', indexed: false },
    ],
  },
  { type: 'event', name: 'PoolDelisted', anonymous: false, inputs: [{ name: 'pool', type: 'address', indexed: true }] },
  {
    type: 'event', name: 'PoolBelowGate', anonymous: false,
    inputs: [
      { name: 'pool', type: 'address', indexed: true },
      { name: 'depth', type: 'uint256', indexed: false },
      { name: 'cardinality', type: 'uint256', indexed: false },
    ],
  },

  // ── errors the writes can raise, so a dry run says WHY it failed ──
  { type: 'error', name: 'NotDue', inputs: [{ name: 'roundId', type: 'uint256' }] },
  { type: 'error', name: 'NotActivated', inputs: [{ name: 'roundId', type: 'uint256' }] },
  { type: 'error', name: 'AlreadySettled', inputs: [{ name: 'roundId', type: 'uint256' }] },
  { type: 'error', name: 'StrikeAlreadyFixed', inputs: [{ name: 'roundId', type: 'uint256' }] },
  { type: 'error', name: 'PriceUnavailableNow', inputs: [{ name: 'roundId', type: 'uint256' }] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [] },
  { type: 'error', name: 'TickOutOfPoolRange', inputs: [{ name: 'meanTick', type: 'int56' }] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'PoolNotListed', inputs: [{ name: 'pool', type: 'address' }] },
  { type: 'error', name: 'PoolAboveGate', inputs: [{ name: 'pool', type: 'address' }, { name: 'depth', type: 'uint256' }] },
  { type: 'error', name: 'PoolTooThin', inputs: [{ name: 'depth', type: 'uint256' }] },
  { type: 'error', name: 'BankTooLargeForPool', inputs: [{ name: 'bank', type: 'uint256' }, { name: 'maxBank', type: 'uint256' }] },
] as const

/**
 * The events discovery asks getLogs for. Every one of them must carry a
 * `roundId` argument. Any of them names a round that exists; the ones in
 * CLOSING_EVENTS also say it owes nothing more.
 */
export const DISCOVERY_EVENTS = ['RoundOpened', 'Bet', 'StrikeFixed', 'RoundSettled'] as const
export type DiscoveryEventName = (typeof DISCOVERY_EVENTS)[number]
export const CLOSING_EVENTS: readonly DiscoveryEventName[] = ['RoundSettled']

/**
 * The events that say which pools take bets: PoolListed adds one, PoolDelisted
 * (also emitted by delistIfBelowGate, right after PoolBelowGate) removes it.
 */
export const POOL_EVENTS = ['PoolListed', 'PoolDelisted'] as const
export type PoolEventName = (typeof POOL_EVENTS)[number]

/** PoolRounds.Outcome. NONE is "not settled" (or not activated: see roundView().activated). */
export const Outcome = { NONE: 0, UP: 1, DOWN: 2, TIE: 3, REFUND: 4 } as const
export const OUTCOME_NAMES = ['NONE', 'UP', 'DOWN', 'TIE', 'REFUND'] as const

/**
 * RoundSettled.reason, by name: 0 priced, 1 the ring lost a window, 2 exit
 * spread, 3 SETTLE_GRACE lapsed, 4 a price window carried less WETH depth than
 * bank x depthPerBank (the depth rule, re-audit V3-1).
 */
export const SETTLE_REASON_NAMES = ['priced', 'history-gone', 'spread', 'grace', 'thin-window'] as const

/** A reason by name; an unknown number is shown as reason-N rather than dropped. */
export function reasonName(reason: number): string {
  return SETTLE_REASON_NAMES[reason] ?? `reason-${reason}`
}

// ── where it lives ────────────────────────────────────────────────────

export interface RoundsDeployment {
  address: Address
  /**
   * Block PoolRounds was deployed in, from ROUNDS_START_BLOCK. Discovery starts
   * here on its very first run; null means "a lookback from the head", which
   * can miss rounds older than the lookback on a first run.
   */
  startBlock: bigint | null
}

/**
 * ROUNDS_ADDRESS and ROUNDS_START_BLOCK. DeployPoolRounds.s.sol prints the
 * address as `POOL_ROUNDS=...`; that value goes into ROUNDS_ADDRESS.
 *
 * Returns an error string instead of throwing: a mistyped rounds variable must
 * not take down the keeper of the existing markets (keeper/index.ts logs it and
 * starts without rounds).
 */
export function roundsDeploymentFromEnv(env: NodeJS.ProcessEnv): RoundsDeployment | { error: string } {
  const raw = (env.ROUNDS_ADDRESS ?? '').trim()
  if (!raw) return { error: 'ROUNDS_ADDRESS is not set' }
  if (!isAddress(raw, { strict: false })) return { error: `ROUNDS_ADDRESS is not an address: ${JSON.stringify(raw)}` }
  if (/^0x0{40}$/i.test(raw)) return { error: 'ROUNDS_ADDRESS is the zero address' }

  const sb = (env.ROUNDS_START_BLOCK ?? '').trim()
  let startBlock: bigint | null = null
  if (sb) {
    if (!/^\d+$/.test(sb)) return { error: `ROUNDS_START_BLOCK must be a block number, got ${JSON.stringify(sb)}` }
    startBlock = BigInt(sb)
  }
  return { address: getAddress(raw), startBlock }
}

// ── round id: pool (160 bits) | duration (32 bits) | index (64 bits) ─────

const MASK_32 = (1n << 32n) - 1n
const MASK_64 = (1n << 64n) - 1n

/** PoolRounds.roundIdOf. */
export function roundIdOf(pool: Address, duration: bigint | number, index: bigint | number): bigint {
  const d = BigInt(duration)
  const k = BigInt(index)
  if (d < 0n || d > MASK_32) throw new RangeError(`duration out of range: ${d}`)
  if (k < 0n || k > MASK_64) throw new RangeError(`index out of range: ${k}`)
  return (BigInt(pool) << 96n) | (d << 64n) | k
}

/** PoolRounds.decodeRoundId: each field is cut out of its own bit range. */
export function decodeRoundId(roundId: bigint): { pool: Address; duration: bigint; index: bigint } {
  const pool = getAddress(`0x${(roundId >> 96n).toString(16).padStart(40, '0').slice(-40)}`)
  return { pool, duration: (roundId >> 64n) & MASK_32, index: roundId & MASK_64 }
}

/** A round id as a short readable label for logs: pool prefix, duration, index. */
export function roundLabel(roundId: bigint): string {
  const { pool, duration, index } = decodeRoundId(roundId)
  return `${pool.slice(0, 10)}/${duration}s/#${index}`
}

// ── deadlines: read from the contract, never computed here ─────────────

/** The Times struct as viem decodes it from roundTimes() and roundView() (names from the ABI above). */
export interface RawTimes {
  openAt: bigint
  closeAt: bigint
  strikeStart: bigint
  strikeEnd: bigint
  settleAt: bigint
}

/**
 * A round's deadlines, in chain seconds, exactly as the contract states them.
 * In v3 the book is final at closeAt: a round that is not activated then owes
 * no keeper call at all.
 */
export interface RoundTimes {
  openAt: number
  /** Bets stop, and the book is final. */
  closeAt: number
  /** First second of the strike window; the pause lies between closeAt and here. */
  strikeStart: number
  /** fixStrike becomes callable. */
  strikeEnd: number
  /** settle becomes callable; settleAt + SETTLE_GRACE is the refund branch. */
  settleAt: number
}

/** THE mapping from the contract's Times to the keeper's. The one place to change with the struct. */
export function timesFromContract(t: RawTimes): RoundTimes {
  return {
    openAt: Number(t.openAt),
    closeAt: Number(t.closeAt),
    strikeStart: Number(t.strikeStart),
    strikeEnd: Number(t.strikeEnd),
    settleAt: Number(t.settleAt),
  }
}

const TIME_KEYS = ['openAt', 'closeAt', 'strikeStart', 'strikeEnd', 'settleAt'] as const

/**
 * Deadlines that cannot be a round's: out of order, empty windows, or so large
 * that the decode clearly read the wrong words. The keeper does not know the
 * formula behind them and does not need to; it does know their order.
 */
function badTimes(t: RoundTimes): string | null {
  for (let i = 0; i < TIME_KEYS.length; i++) {
    const v = t[TIME_KEYS[i]]
    if (!Number.isSafeInteger(v) || v < 0 || v > 2 ** 40) return `${TIME_KEYS[i]} ${v} is not a timestamp`
    if (i > 0 && v < t[TIME_KEYS[i - 1]]) return `${TIME_KEYS[i]} ${v} < ${TIME_KEYS[i - 1]} ${t[TIME_KEYS[i - 1]]}`
  }
  if (t.closeAt === t.openAt || t.strikeEnd === t.strikeStart || t.settleAt === t.strikeEnd) {
    return 'a round with an empty betting, strike or exit window'
  }
  return null
}

/** roundTimes(roundId), checked. */
export function checkRoundTimes(roundId: bigint, raw: RawTimes): RoundTimes {
  const t = timesFromContract(raw)
  const bad = badTimes(t)
  if (bad) throw new RoundsAbiMismatchError(roundId, bad, 'roundTimes')
  return t
}

// ── hard deadlines: keeperDeadlines(roundId), never computed here ────────

/** keeperDeadlines(roundId) as viem decodes it. */
export interface RawDeadlines {
  fixStrikeBy: bigint
  settleBy: bigint
}

/**
 * The last second at which fixStrike and settle are still sure to read their
 * windows, even on a pool that writes an observation every second
 * (ROUNDS-CONTRACT.md, keeper deadlines). The contract computes them from its
 * ring gate; with the deployment defaults that is strikeEnd + 599 and
 * settleAt + 839 (settleAt + 719 for 900 s rounds). Past them a busy pool can
 * lose the window, and a lost window is REFUND.
 */
export interface CallDeadlines {
  fixStrikeBy: number
  settleBy: number
}

/** keeperDeadlines(roundId), checked against the round's own times: neither may come before its call is due. */
export function checkDeadlines(roundId: bigint, raw: RawDeadlines, t: RoundTimes): CallDeadlines {
  const d = { fixStrikeBy: Number(raw.fixStrikeBy), settleBy: Number(raw.settleBy) }
  const ok = Number.isSafeInteger(d.fixStrikeBy) && Number.isSafeInteger(d.settleBy) &&
    d.fixStrikeBy >= t.strikeEnd && d.settleBy >= t.settleAt
  if (!ok) {
    throw new RoundsAbiMismatchError(
      roundId,
      `fixStrikeBy ${d.fixStrikeBy}, settleBy ${d.settleBy} against strikeEnd ${t.strikeEnd}, settleAt ${t.settleAt}`,
      'keeperDeadlines',
    )
  }
  return d
}

// ── roundView, decoded and checked ────────────────────────────────────

/** roundView as the keeper uses it: times in seconds, money in wei. */
export interface RoundState {
  roundId: bigint
  pool: Address
  duration: number
  index: bigint
  times: RoundTimes
  committed: bigint
  rawUp: bigint
  rawDown: bigint
  bank: bigint
  minBank: bigint
  /** The round's own snapshot, taken at its first bet: the ceiling on what the keeper may spend on it. */
  costAllowance: bigint
  /** The contract's "past closeAt" at the block it answered from. */
  bookClosed: boolean
  activated: boolean
  strikeFixed: boolean
  outcome: number
}

/** What viem hands back for roundView (field names from the ABI above). */
export interface RawRoundView {
  pool: Address
  duration: bigint
  index: bigint
  times: RawTimes
  committed: bigint
  rawUp: bigint
  rawDown: bigint
  acceptedUp: bigint
  acceptedDown: bigint
  bank: bigint
  minBank: bigint
  costAllowance: bigint
  bookClosed: boolean
  activated: boolean
  strikeFixed: boolean
  outcome: number
  entryTick: number
  exitTick: number
}

export class RoundsAbiMismatchError extends Error {
  constructor(roundId: bigint, what: string, fn = 'roundView') {
    super(
      `${fn}(${roundId}) does not describe the round that was asked about (${what}): ` +
      `the ABI in backend/src/rounds/contract.ts does not match the deployed PoolRounds - refusing to act`,
    )
    this.name = 'RoundsAbiMismatchError'
  }
}

/**
 * Decode and cross-check one roundView answer: the pool, duration and window
 * index are fixed by the round id's bit layout, the deadlines must be the ones
 * roundTimes(roundId) gave (`known`, when the keeper has them) and be in order.
 * A view that disagrees on any of that was decoded with the wrong ABI, and
 * every other field in it is as wrong.
 */
export function checkRoundView(roundId: bigint, raw: RawRoundView, known: RoundTimes | null): RoundState {
  const id = decodeRoundId(roundId)
  if (getAddress(raw.pool) !== id.pool) throw new RoundsAbiMismatchError(roundId, `pool ${raw.pool}`)
  if (raw.duration !== id.duration) throw new RoundsAbiMismatchError(roundId, `duration ${raw.duration}`)
  if (raw.index !== id.index) throw new RoundsAbiMismatchError(roundId, `index ${raw.index}`)
  const t = timesFromContract(raw.times)
  const bad = badTimes(t)
  if (bad) throw new RoundsAbiMismatchError(roundId, bad)
  if (known) {
    for (const k of TIME_KEYS) {
      if (t[k] !== known[k]) throw new RoundsAbiMismatchError(roundId, `times.${k} ${t[k]} != roundTimes ${known[k]}`)
    }
  }
  if (raw.outcome > Outcome.REFUND) throw new RoundsAbiMismatchError(roundId, `outcome ${raw.outcome}`)
  return {
    roundId,
    pool: id.pool,
    duration: Number(id.duration),
    index: id.index,
    times: t,
    committed: raw.committed,
    rawUp: raw.rawUp,
    rawDown: raw.rawDown,
    bank: raw.bank,
    minBank: raw.minBank,
    costAllowance: raw.costAllowance,
    bookClosed: raw.bookClosed,
    activated: raw.activated,
    strikeFixed: raw.strikeFixed,
    outcome: raw.outcome,
  }
}
