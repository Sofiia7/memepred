/**
 * PoolRounds, as the rounds screen sees it: the ABI and the address, in one place.
 *
 * The array below is the part of PoolRounds (interface v3: visible bets, sides
 * matched up to maxSideRatio, a pause before the strike) that the screen uses,
 * with every custom error, copied from the forge build artifact
 * contracts/out/PoolRounds.sol/PoolRounds.json. Only roundsClient.ts calls the
 * contract; nothing else in frontend/src/rounds reads this array.
 *
 * When the contract changes: forge build in contracts/, regenerate the array
 * (from the repository root)
 *   node -e "const k=new Set(process.argv.slice(1));const a=require('./contracts/out/PoolRounds.sol/PoolRounds.json').abi;console.log(a.filter(e=>e.type==='error'||k.has(e.name)).map(e=>'  '+JSON.stringify(e)+',').join('\n'))" weth minStake maxStake minBank costAllowance paused NORMAL_FEE_BPS VOID_FEE_BPS maxSideRatio strikePause strikeWindow depthPerBank gateDepth maxBankOf wethDepth SETTLE_GRACE durationEnabled pools roundTimes roundView ticketOf previewClaim bet claim Bet Claimed PoolListed PoolDelisted DurationSet RoundSettled
 * and fix the mapping in roundsClient.ts if a shape moved. roundsAbi.test.ts
 * fails while this array and the artifact disagree.
 */
import { getAddress, isAddress, type Address } from 'viem'

// Generated from contracts/out/PoolRounds.sol/PoolRounds.json (UI subset). Do not edit by hand.
export const POOL_ROUNDS_ABI = [
  {"type":"function","name":"NORMAL_FEE_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"SETTLE_GRACE","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"VOID_FEE_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"bet","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"stake","type":"uint256","internalType":"uint256"},{"name":"side","type":"uint8","internalType":"enum PoolRounds.Side"},{"name":"referrer","type":"address","internalType":"address"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"claim","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"payout","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"costAllowance","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"depthPerBank","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"durationEnabled","inputs":[{"name":"","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"gateDepth","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"maxBankOf","inputs":[{"name":"pool","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"maxSideRatio","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"maxStake","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"minBank","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"minStake","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"paused","inputs":[],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"pools","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"listed","type":"bool","internalType":"bool"},{"name":"wethIsToken0","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"previewClaim","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"player","type":"address","internalType":"address"}],"outputs":[{"name":"payout","type":"uint256","internalType":"uint256"},{"name":"referralShare","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"roundTimes","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"t","type":"tuple","internalType":"struct PoolRounds.Times","components":[{"name":"openAt","type":"uint256","internalType":"uint256"},{"name":"closeAt","type":"uint256","internalType":"uint256"},{"name":"strikeStart","type":"uint256","internalType":"uint256"},{"name":"strikeEnd","type":"uint256","internalType":"uint256"},{"name":"settleAt","type":"uint256","internalType":"uint256"}]}],"stateMutability":"view"},
  {"type":"function","name":"roundView","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"v","type":"tuple","internalType":"struct PoolRounds.RoundView","components":[{"name":"pool","type":"address","internalType":"address"},{"name":"duration","type":"uint256","internalType":"uint256"},{"name":"index","type":"uint256","internalType":"uint256"},{"name":"times","type":"tuple","internalType":"struct PoolRounds.Times","components":[{"name":"openAt","type":"uint256","internalType":"uint256"},{"name":"closeAt","type":"uint256","internalType":"uint256"},{"name":"strikeStart","type":"uint256","internalType":"uint256"},{"name":"strikeEnd","type":"uint256","internalType":"uint256"},{"name":"settleAt","type":"uint256","internalType":"uint256"}]},{"name":"committed","type":"uint256","internalType":"uint256"},{"name":"rawUp","type":"uint256","internalType":"uint256"},{"name":"rawDown","type":"uint256","internalType":"uint256"},{"name":"acceptedUp","type":"uint256","internalType":"uint256"},{"name":"acceptedDown","type":"uint256","internalType":"uint256"},{"name":"bank","type":"uint256","internalType":"uint256"},{"name":"minBank","type":"uint256","internalType":"uint256"},{"name":"costAllowance","type":"uint256","internalType":"uint256"},{"name":"bookClosed","type":"bool","internalType":"bool"},{"name":"activated","type":"bool","internalType":"bool"},{"name":"strikeFixed","type":"bool","internalType":"bool"},{"name":"outcome","type":"uint8","internalType":"enum PoolRounds.Outcome"},{"name":"entryTick","type":"int24","internalType":"int24"},{"name":"exitTick","type":"int24","internalType":"int24"}]}],"stateMutability":"view"},
  {"type":"function","name":"strikePause","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"strikeWindow","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"ticketOf","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"player","type":"address","internalType":"address"}],"outputs":[{"name":"stake","type":"uint256","internalType":"uint256"},{"name":"side","type":"uint8","internalType":"enum PoolRounds.Side"},{"name":"status","type":"uint8","internalType":"enum PoolRounds.TicketStatus"}],"stateMutability":"view"},
  {"type":"function","name":"weth","inputs":[],"outputs":[{"name":"","type":"address","internalType":"contract IERC20"}],"stateMutability":"view"},
  {"type":"function","name":"wethDepth","inputs":[{"name":"pool","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"event","name":"Bet","inputs":[{"name":"roundId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"player","type":"address","indexed":true,"internalType":"address"},{"name":"side","type":"uint8","indexed":false,"internalType":"enum PoolRounds.Side"},{"name":"stake","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"Claimed","inputs":[{"name":"roundId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"player","type":"address","indexed":true,"internalType":"address"},{"name":"payout","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"referrer","type":"address","indexed":true,"internalType":"address"},{"name":"referralShare","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"DurationSet","inputs":[{"name":"duration","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"enabled","type":"bool","indexed":false,"internalType":"bool"}],"anonymous":false},
  {"type":"event","name":"PoolDelisted","inputs":[{"name":"pool","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},
  {"type":"event","name":"PoolListed","inputs":[{"name":"pool","type":"address","indexed":true,"internalType":"address"},{"name":"wethIsToken0","type":"bool","indexed":false,"internalType":"bool"}],"anonymous":false},
  {"type":"event","name":"RoundSettled","inputs":[{"name":"roundId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"outcome","type":"uint8","indexed":false,"internalType":"enum PoolRounds.Outcome"},{"name":"reason","type":"uint8","indexed":false,"internalType":"uint8"},{"name":"entryPrice","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"exitPrice","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"bank","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"grossFee","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"referralPot","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"error","name":"AlreadyBet","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"player","type":"address","internalType":"address"}]},
  {"type":"error","name":"AlreadyClaimed","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"player","type":"address","internalType":"address"}]},
  {"type":"error","name":"AlreadySettled","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"BankTooLargeForPool","inputs":[{"name":"bank","type":"uint256","internalType":"uint256"},{"name":"maxBank","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"CardinalityTooLow","inputs":[{"name":"have","type":"uint256","internalType":"uint256"},{"name":"need","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"DurationNotEnabled","inputs":[{"name":"duration","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"EnforcedPause","inputs":[]},
  {"type":"error","name":"ExpectedPause","inputs":[]},
  {"type":"error","name":"InvalidSide","inputs":[]},
  {"type":"error","name":"NoCode","inputs":[{"name":"account","type":"address","internalType":"address"}]},
  {"type":"error","name":"NoTicket","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"},{"name":"player","type":"address","internalType":"address"}]},
  {"type":"error","name":"NotActivated","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"NotCanonicalPool","inputs":[{"name":"pool","type":"address","internalType":"address"}]},
  {"type":"error","name":"NotCollecting","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"NotDue","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"NotPauser","inputs":[]},
  {"type":"error","name":"NotSettled","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"NotWethPool","inputs":[{"name":"pool","type":"address","internalType":"address"}]},
  {"type":"error","name":"NothingToWithdraw","inputs":[]},
  {"type":"error","name":"OutOfBounds","inputs":[{"name":"value","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"OwnableInvalidOwner","inputs":[{"name":"owner","type":"address","internalType":"address"}]},
  {"type":"error","name":"OwnableUnauthorizedAccount","inputs":[{"name":"account","type":"address","internalType":"address"}]},
  {"type":"error","name":"PoolAboveGate","inputs":[{"name":"pool","type":"address","internalType":"address"},{"name":"depth","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"PoolCannotServeWindow","inputs":[{"name":"window","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"PoolNotListed","inputs":[{"name":"pool","type":"address","internalType":"address"}]},
  {"type":"error","name":"PoolTooThin","inputs":[{"name":"depth","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"PriceUnavailableNow","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"ReentrancyGuardReentrantCall","inputs":[]},
  {"type":"error","name":"SafeERC20FailedOperation","inputs":[{"name":"token","type":"address","internalType":"address"}]},
  {"type":"error","name":"SelfReferral","inputs":[]},
  {"type":"error","name":"StakeOutOfBounds","inputs":[{"name":"stake","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"StrikeAlreadyFixed","inputs":[{"name":"roundId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"TickOutOfPoolRange","inputs":[{"name":"meanTick","type":"int56","internalType":"int56"}]},
  {"type":"error","name":"TickOutOfRange","inputs":[]},
  {"type":"error","name":"ZeroAddress","inputs":[]},
] as const

// ── where it lives, and whether this build shows it at all ─────────────────

/**
 * The rounds screen is off unless a build turns it on. The public demo keeps
 * looking exactly as it does until the owner decides on v2: with the flag off
 * no route and no tab is mounted, and nothing here is read.
 *
 *   VITE_ROUNDS_ENABLED       "1" turns the screen on; anything else keeps it off
 *   VITE_POOL_ROUNDS_ADDRESS  the PoolRounds contract on the build's chain
 *   VITE_ROUNDS_DEPLOY_BLOCK  optional; the block it was deployed in. Past bets
 *                             and listed pools are found by scanning logs from
 *                             here, so set it on a real chain (0 scans from genesis)
 *   VITE_ROUNDS_DURATIONS     optional; durations in seconds to look for besides
 *                             the ones DurationSet events announce, default 300,900.
 *                             Each is shown only if durationEnabled() says so.
 */
export interface RoundsConfig {
  enabled: boolean
  address?: Address
  deployBlock: bigint
  durations: number[]
  /** Why the screen cannot work with this env; empty when it can. */
  problems: string[]
}

type EnvLike = Record<string, string | boolean | undefined>

export const DEFAULT_ROUND_DURATIONS = [300, 900]

function str(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Pure, so the rules can be tested without a build. Never throws. */
export function readRoundsConfig(env: EnvLike): RoundsConfig {
  const problems: string[] = []
  // Exactly "1", untrimmed: the same rule as flag.ts, which decides whether the route exists.
  const enabled = env.VITE_ROUNDS_ENABLED === '1'

  let address: Address | undefined
  const rawAddress = str(env.VITE_POOL_ROUNDS_ADDRESS)
  if (rawAddress && isAddress(rawAddress, { strict: false }) && !/^0x0{40}$/i.test(rawAddress)) {
    address = getAddress(rawAddress)
  } else if (enabled) {
    problems.push('VITE_POOL_ROUNDS_ADDRESS (missing or not an address)')
  }

  let deployBlock = 0n
  const rawBlock = str(env.VITE_ROUNDS_DEPLOY_BLOCK)
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) deployBlock = BigInt(rawBlock)
    else problems.push('VITE_ROUNDS_DEPLOY_BLOCK (must be a whole block number)')
  }

  let durations = DEFAULT_ROUND_DURATIONS
  const rawDurations = str(env.VITE_ROUNDS_DURATIONS)
  if (rawDurations) {
    const parsed = rawDurations.split(',').map((s) => s.trim()).filter(Boolean)
    const ok = parsed.every((s) => /^\d+$/.test(s) && Number(s) > 0 && Number(s) <= 86_400)
    if (ok && parsed.length > 0) durations = [...new Set(parsed.map(Number))].sort((a, b) => a - b)
    else problems.push('VITE_ROUNDS_DURATIONS (comma-separated seconds, e.g. 300,900)')
  }

  return { enabled, address, deployBlock, durations, problems }
}

export const ROUNDS_CONFIG: RoundsConfig = readRoundsConfig(import.meta.env as unknown as EnvLike)
