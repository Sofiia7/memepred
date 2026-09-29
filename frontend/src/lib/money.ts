import { formatUnits } from 'viem'

/**
 * A token amount for a balance line: trailing zeros trimmed, at most
 * `maxFraction` decimals, and never a silent "0" for a balance that is not
 * quite zero (0.0000004 ETH is not "nothing", it is "less than the display
 * precision").
 *
 * viem's formatUnits already trims zeros but keeps every digit, so an 18
 * decimal balance would print as 0.012345678901234567 in a space built for
 * "0.0123".
 */
export function formatAmount(value: bigint, decimals = 18, maxFraction = 6): string {
  const [whole, frac = ''] = formatUnits(value, decimals).split('.')
  const cut = frac.slice(0, maxFraction).replace(/0+$/, '')
  if (cut.length > 0) return `${whole}.${cut}`
  if (value > 0n && whole === '0') return `<${(10 ** -maxFraction).toFixed(maxFraction)}`
  return whole
}
