/**
 * Which settlement entrypoint the deployed resolver actually has.
 *
 * `resolveOrderbookMarketBatchFrom` was added so that a match which cannot
 * settle stops hiding the ones queued behind it. The resolver live on Base
 * Sepolia predates it, and contracts are meant to redeploy with the post-audit
 * set rather than ahead of it - so for a while the keeper has to run against
 * both. Calling a selector a contract does not implement reverts with no data,
 * which the settle loop's simulation guard reads as "do not send": shipping
 * the keeper against the old resolver without this would stop settlement
 * completely, for the one reason that looks exactly like a healthy refusal.
 *
 * Detected from the runtime bytecode rather than by trying the call and
 * interpreting the failure. solc's dispatcher embeds every selector it handles
 * as a PUSH4 constant, so the answer is unambiguous and needs no heuristics
 * about revert data.
 */

/** keccak("resolveOrderbookMarketBatchFrom(address,uint256,uint256)")[0:4] */
export const BATCH_FROM_SELECTOR = '0xb29e7156'

/** Whether `code` dispatches `selector`. Both are 0x-prefixed hex. */
export function codeHasSelector(code: string | undefined | null, selector: string): boolean {
  if (!code || code.length <= 2) return false
  return code.toLowerCase().includes(selector.toLowerCase().slice(2))
}
