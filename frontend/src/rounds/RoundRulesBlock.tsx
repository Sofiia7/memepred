import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { roundRules, type RulesInput } from './roundRules'

/**
 * Optional details for a round. The one-time RiskGate already records consent.
 *
 * The same block, classes and toggle as components/ui/PreSignRules, which the
 * market Composer shows. That component is not reused as is because its five
 * points describe the order book (matching against the LP vault, a match
 * timeout, a price band, a TWAP taken when you are matched): true there, false
 * for a round, and changing it is outside this screen's files. The points here
 * come from roundRules(), built from the contract's own numbers.
 */
export function RoundRulesBlock(props: RulesInput) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const rules = roundRules(props)
  return (
    <>
      <div className="rules">
        <button type="button" className="rules-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
          <span>Detailed rules</span>
          <span className="rules-state">{open ? 'HIDE' : 'SHOW'}</span>
        </button>
        {open && (
          <ul className="rules-list" id={listId}>
            {rules.map((r) => (
              <li key={r.id} data-rule={r.id}>
                <b>{r.title}.</b> {r.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="rnd-links">
        Full rules and risks: <Link to="/terms">Terms</Link> · <Link to="/how-it-works">How it works</Link>
      </p>
    </>
  )
}
