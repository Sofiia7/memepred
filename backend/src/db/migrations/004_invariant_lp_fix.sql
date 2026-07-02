-- =============================================================
-- Sprint 5H.3 — LP-aware invariant redefinition
--
-- The 003 formula (expected = deposits - claims - refunds, actual = USDC on
-- market contracts only) produced FALSE drift once LP matching went live:
-- the LiquidityPool injects its side into the market on match and pulls
-- 2*amount back on an LP win. Those market↔pool transfers are internal to the
-- {markets ∪ pool} system, so counting market balance against user-only flows
-- drifts by exactly the injected LP amount → false 'critical' → /health 503.
--
-- Correct, LP-agnostic per-market invariant: a market's USDC balance must equal
-- exactly what it still OWES —
--   A  unmatched, refundable remainder still held         (amount - filled)
--   B  funds locked in UNSETTLED matches                  (2 * amount, both sides)
--   C  settled-but-unclaimed user winnings still held     (accumulated payout)
-- LP-injected funds appear as the counterparty side of B, so they cancel
-- naturally: on LP win the 2*amount leaves to the pool AND the match flips to
-- settled (drops out of B) in the same tx. Pool + FeeDistributor solvency is a
-- separate concern (LiquidityPool.isFullyBacked()), intentionally out of scope.
-- =============================================================

-- 003 defined market_usdc_flows / protocol_usdc_summary with a different column
-- set; CREATE OR REPLACE VIEW can't change columns, so drop in dependency order
-- first (summary depends on flows). Idempotent — safe to re-run.
DROP VIEW IF EXISTS protocol_usdc_summary;
DROP VIEW IF EXISTS market_usdc_flows;

-- B: funds locked in unsettled matches, per market (both sides = 2 * amount).
CREATE OR REPLACE VIEW market_locked_matches AS
SELECT
  market_address,
  COALESCE(SUM(CASE WHEN NOT settled THEN amount_usdc * 2 ELSE 0 END), 0) AS locked_in_matches
FROM matches
GROUP BY market_address;

-- A + C (+ reporting aggregates) derived from orders, per market.
CREATE OR REPLACE VIEW market_order_obligations AS
SELECT
  market_address,
  -- A: unmatched remainder still sitting in the market, not yet refunded.
  COALESCE(SUM(
    CASE WHEN status IN ('PENDING','MATCHED') AND NOT unmatched_refunded
         THEN amount_usdc - filled_amount ELSE 0 END
  ), 0) AS unmatched_held,
  -- C: winnings accumulated by settlement but not yet claimed. payout accrues
  --    while status is still MATCHED (multi-fill: some matches settled, some
  --    not) and stays until claim, so count MATCHED+SETTLED, exclude CLAIMED.
  COALESCE(SUM(
    CASE WHEN status IN ('MATCHED','SETTLED') THEN COALESCE(payout_usdc, 0) ELSE 0 END
  ), 0) AS unclaimed_payout,
  -- Reporting only (not part of the invariant).
  COALESCE(SUM(amount_usdc), 0)                                              AS total_deposited,
  COALESCE(SUM(CASE WHEN status = 'CLAIMED' THEN payout_usdc ELSE 0 END), 0) AS total_claimed,
  COALESCE(SUM(
    CASE WHEN status = 'REFUNDED' THEN amount_usdc
         WHEN unmatched_refunded  THEN amount_usdc - filled_amount
         ELSE 0 END
  ), 0)                                                                      AS total_refunded
FROM orders
GROUP BY market_address;

-- Per-market: expected on-chain USDC balance = A + B + C.
CREATE OR REPLACE VIEW market_usdc_flows AS
SELECT
  m.market_address,
  m.feed_symbol,
  m.status,
  m.close_time,
  COALESCE(oo.unmatched_held, 0)                                            AS unmatched_held,
  COALESCE(lm.locked_in_matches, 0)                                         AS locked_in_matches,
  COALESCE(oo.unclaimed_payout, 0)                                          AS unclaimed_payout,
  COALESCE(oo.unmatched_held, 0)
    + COALESCE(lm.locked_in_matches, 0)
    + COALESCE(oo.unclaimed_payout, 0)                                      AS expected_balance,
  COALESCE(oo.total_deposited, 0)                                           AS total_deposited,
  COALESCE(oo.total_claimed, 0)                                             AS total_claimed,
  COALESCE(oo.total_refunded, 0)                                            AS total_refunded
FROM markets m
LEFT JOIN market_order_obligations oo ON oo.market_address = m.market_address
LEFT JOIN market_locked_matches    lm ON lm.market_address = m.market_address;

-- Protocol rollup. expected_onchain_balance now = Σ per-market (A+B+C), which is
-- directly comparable to Σ on-chain balanceOf(market) that invariantMonitor reads.
CREATE OR REPLACE VIEW protocol_usdc_summary AS
SELECT
  COUNT(*)                       AS markets,
  SUM(total_deposited)           AS total_deposited,
  SUM(total_claimed)             AS total_claimed,
  SUM(total_refunded)            AS total_refunded,
  SUM(expected_balance)          AS expected_onchain_balance
FROM market_usdc_flows;
