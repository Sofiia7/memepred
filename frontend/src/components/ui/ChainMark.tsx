import { IS_POOL_BACKED } from '../../lib/chain'

/**
 * The small square that sat inside the sign-in button and the CTA was styled as
 * the Base mark (`.basesq`). It is still right on a Base build; on Robinhood
 * Chain it read as "this is Base", so that build gets a plain neutral dot.
 * Purely decorative: hidden from assistive technology either way.
 */
export function ChainMark() {
  return <span className={IS_POOL_BACKED ? 'chainmark' : 'basesq'} aria-hidden="true" />
}
