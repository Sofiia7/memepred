-- 006: a tie is a real, distinct outcome now (OrderbookMarket.sol emits
-- MatchTied instead of MatchSettled when exitPrice == entryPrice, refunding
-- both stakes with no fee), and the price columns were too narrow for an
-- extreme-ratio token pair. Additive only, per this branch's own rule.

-- A tie is neither UP nor DOWN winning. Recording it as its own column
-- rather than overloading up_won=NULL: NULL already means "not settled yet"
-- everywhere up_won is read (profile.ts's WON_EXPR, markets.ts), and giving
-- it a second meaning for the same column would make every existing NULL
-- check ambiguous instead of just adding one new, explicit case.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tied BOOLEAN NOT NULL DEFAULT FALSE;

-- entry_price/exit_price hold the raw on-chain WAD-scaled quote (NOT divided
-- by the currency's decimals the way amount_usdc is - see indexer.ts's
-- OrderMatched/LPMatched handlers, which insert a.entryPrice.toString()
-- directly). NUMERIC(40,18) holds at most ~10^22 before the decimal point.
-- A price ratio far from 1 - a very low-value, high-supply token quoted in
-- WETH, or the reciprocal of one - can exceed that, and because the
-- "already ingested" mark commits before the rest of that log's writes
-- (indexer.ts's markIngested runs first), an overflow here doesn't just
-- fail the price write: it silently drops the whole match and its
-- order_matches rows, permanently, with no retry. Unconstrained precision
-- removes the ceiling; scale 18 is unchanged so every existing value reads
-- back identical.
ALTER TABLE matches ALTER COLUMN entry_price TYPE NUMERIC;
ALTER TABLE matches ALTER COLUMN exit_price TYPE NUMERIC;

-- stale_settlements had no upper bound, so ANY match that never gets
-- settled=TRUE in this projection - a tie before this migration (it was
-- recorded only via OrderRefunded, never marked settled), or a match
-- resolved on-chain via the permissionless emergencyRefundMatch (which this
-- indexer still has no event handler for at all - a separate, smaller gap)
-- - stayed "overdue" here forever. /health/deep and /api/keeper/health read
-- this view and go red on anything in it past a few minutes, so one such
-- match meant a permanently red health check that stopped meaning anything.
-- Bounding the window to SETTLE_GRACE (24h, OrderbookMarket.sol) plus a
-- margin lets a match that is never going to update in THIS table age back
-- out of "currently overdue" instead of staying there indefinitely - it is
-- still visible via a direct query on `matches` for anyone who wants the
-- full history, just not as a permanent false alarm here.
CREATE OR REPLACE VIEW stale_settlements AS
SELECT
  market_address,
  match_id,
  amount_usdc,
  matched_at,
  settle_at,
  EXTRACT(EPOCH FROM (NOW() - settle_at))::INTEGER AS overdue_secs
FROM matches
WHERE settled = FALSE
  AND settle_at < NOW() - INTERVAL '5 minutes'
  AND settle_at > NOW() - INTERVAL '25 hours';
