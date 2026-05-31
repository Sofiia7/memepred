-- =============================================================
-- Sprint 5.6 — USDC conservation invariant views
--
-- For every market, the contract MUST satisfy:
--
--   sum(deposits)  ==  sum(payouts)  +  sum(refunds)  +  on_chain_balance
--
-- The invariant_monitor cron compares these aggregates and alerts on drift
-- > $1 USDC. Drift is either a real bug (block) or an indexer lag
-- (transient — verify on subgraph too).
-- =============================================================

-- Per-market USDC accounting derived from event-projected tables.
CREATE OR REPLACE VIEW market_usdc_flows AS
SELECT
  m.market_address,
  m.feed_symbol,
  m.status,
  m.close_time,
  -- Deposits = sum of placed order amounts (full deposit, including unmatched portions)
  COALESCE(SUM(o.amount_usdc), 0)                                          AS total_deposited,
  -- Filled = sum of matched portions (what was actually put at risk)
  COALESCE(SUM(o.filled_amount), 0)                                        AS total_filled,
  -- Payouts = sum of payout_usdc on CLAIMED orders
  COALESCE(SUM(CASE WHEN o.status = 'CLAIMED' THEN o.payout_usdc ELSE 0 END), 0)
                                                                            AS total_claimed,
  -- Refunds = (deposit - filled) on orders where unmatched_refunded=true,
  --          plus full deposit on REFUNDED orders.
  COALESCE(SUM(
    CASE
      WHEN o.status = 'REFUNDED' THEN o.amount_usdc
      WHEN o.unmatched_refunded  THEN o.amount_usdc - o.filled_amount
      ELSE 0
    END
  ), 0)                                                                    AS total_refunded
FROM markets m
LEFT JOIN orders o ON o.market_address = m.market_address
GROUP BY m.market_address, m.feed_symbol, m.status, m.close_time;

-- Cross-market protocol summary.
CREATE OR REPLACE VIEW protocol_usdc_summary AS
SELECT
  COUNT(DISTINCT market_address)             AS markets,
  SUM(total_deposited)                       AS total_deposited,
  SUM(total_filled)                          AS total_filled,
  SUM(total_claimed)                         AS total_claimed,
  SUM(total_refunded)                        AS total_refunded,
  SUM(total_deposited - total_claimed - total_refunded) AS expected_onchain_balance
FROM market_usdc_flows;

-- Per-trader open exposure (PENDING + MATCHED, minus already-refunded unmatched).
CREATE OR REPLACE VIEW trader_open_exposure AS
SELECT
  trader_address,
  COUNT(*)                                    AS open_orders,
  COALESCE(SUM(
    CASE
      WHEN status IN ('PENDING','MATCHED') THEN
        CASE WHEN unmatched_refunded THEN filled_amount ELSE amount_usdc END
      ELSE 0
    END
  ), 0)                                       AS at_risk_usdc
FROM orders
GROUP BY trader_address
HAVING COUNT(*) FILTER (WHERE status IN ('PENDING','MATCHED')) > 0;

-- Settlement health: matches that should be settled but aren't.
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
  AND settle_at < NOW() - INTERVAL '5 minutes';

-- Drift snapshot table — invariant_monitor writes here every minute so
-- we have a history of deviations. > $1 = alert.
CREATE TABLE IF NOT EXISTS invariant_snapshots (
  snapshot_at         TIMESTAMPTZ PRIMARY KEY DEFAULT NOW(),
  total_deposited     NUMERIC(28, 6) NOT NULL,
  total_claimed       NUMERIC(28, 6) NOT NULL,
  total_refunded      NUMERIC(28, 6) NOT NULL,
  expected_balance    NUMERIC(28, 6) NOT NULL,
  actual_balance      NUMERIC(28, 6) NOT NULL,
  drift_usdc          NUMERIC(28, 6) NOT NULL,
  alert_level         TEXT NOT NULL CHECK (alert_level IN ('ok','warn','critical'))
);
CREATE INDEX IF NOT EXISTS invariant_snapshots_alert_idx
  ON invariant_snapshots (alert_level, snapshot_at DESC);
