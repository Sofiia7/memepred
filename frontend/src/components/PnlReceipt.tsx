/**
 * The net result of a finished order, as a receipt: what was staked, what came
 * back, what the fees were, and the one number that answers "did I make money".
 * The arithmetic lives in lib/orderReceipt.ts; this only lays it out.
 */
import { CURRENCY_SYMBOL } from '../lib/contracts'
import { formatAmount, formatPercent, formatSigned, type OrderReceipt } from '../lib/orderReceipt'
import '../order.css'

export function PnlReceipt({ receipt }: { receipt: OrderReceipt }) {
  // Nothing was won or lost (a tie, or every match went back): the card's own
  // headline already says the stake came back, and a table of zeros adds noise.
  if (receipt.atRisk <= 0) return null

  const tone = receipt.net > 1e-9 ? 'gain' : receipt.net < -1e-9 ? 'loss' : 'even'
  const sym = CURRENCY_SYMBOL

  return (
    <div className="osc-pnl" role="group" aria-label="Net result of this order">
      <div className="osc-pnl-row">
        <span>Staked and settled</span>
        <span>{formatAmount(receipt.atRisk)} {sym}</span>
      </div>
      <div className="osc-pnl-row">
        <span>Paid out to you</span>
        <span>{formatAmount(receipt.payout)} {sym}</span>
      </div>
      {receipt.fees > 0 && (
        <div className="osc-pnl-row osc-pnl-sub">
          <span>Fees, already taken off</span>
          <span>{formatAmount(receipt.fees)} {sym}</span>
        </div>
      )}
      {receipt.returned > 0 && (
        <div className="osc-pnl-row osc-pnl-sub">
          <span>Also returned to you in full</span>
          <span>{formatAmount(receipt.returned)} {sym}</span>
        </div>
      )}
      <div className={`osc-pnl-row osc-pnl-net osc-pnl-${tone}`}>
        <span>Net result</span>
        <span>
          {formatSigned(receipt.net)} {sym}
          {receipt.netPct !== null && <> ({formatPercent(receipt.netPct)})</>}
        </span>
      </div>
    </div>
  )
}
