import { useId, useState } from 'react'
import { preSignRules, DEFAULT_SLIPPAGE_BPS } from '../../lib/rules'

/**
 * "What you are agreeing to", shown before the confirm button on Robinhood
 * Chain. The wording comes from lib/rules so the numbers in it are the
 * contract's, not a second copy typed here.
 *
 * Collapsible, and collapsed on a phone: the Composer is a fixed sheet over the
 * page, and five bullets would take half of a small screen. On a wide screen
 * there is room, so it opens by default there. Either way the toggle is one
 * tap and says how many points it hides.
 */
export function PreSignRules({ durationSec, slippageBps = DEFAULT_SLIPPAGE_BPS }: { durationSec: number; slippageBps?: number }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(min-width: 640px)').matches
        : false
    } catch {
      return false
    }
  })
  const listId = useId()
  const rules = preSignRules({ durationSec, slippageBps })

  return (
    <div className="rules">
      <button
        type="button"
        className="rules-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span>What you are agreeing to ({rules.length} points)</span>
        <span className="rules-state">{open ? 'HIDE' : 'SHOW'}</span>
      </button>
      {open && (
        <ul className="rules-list" id={listId}>
          {rules.map((r) => (
            <li key={r.id}>
              <b>{r.title}.</b> {r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
