-- Robinhood Chain support. Additive throughout: nothing is dropped, no column
-- narrows, and every existing Base row keeps the value it already had.
--
-- Three things change, for three different reasons.

-- ── 1. Currency width ──────────────────────────────────────────────────────
-- Every money column in this schema was declared NUMERIC(_, 6) because stakes
-- were six-decimal USDC. Robinhood Chain stakes in eighteen-decimal WETH, and
-- the indexer stores human amounts rather than raw units (it divides by 1e6 in
-- eleven places), so a partial fill of, say, 4e11 wei would land as 0.000000
-- and vanish. MIN_BET there is 0.004 ETH and fills can be far smaller than the
-- order.
--
-- Widening is lossless in both directions of reading: 6 decimals fit inside 18
-- exactly, so existing Base rows are unchanged and Base queries cannot tell.
-- The scale is 18 rather than "enough for now" because that is the width of
-- the currency, and a rounding rule that depends on the chain is a bug waiting
-- for the one market where it matters.
-- Postgres refuses ALTER COLUMN TYPE on anything a view selects, and seven
-- views read these columns, so they come down first and go back up unchanged
-- at the end of this file. Migration 004 does the same dance for the same
-- reason; the definitions below are copied from 002, 003 and 004 verbatim, and
-- the harness in scripts/check-migrations.mjs compares pg_get_viewdef before
-- and after so a transcription slip cannot pass silently.
--
-- Dropped most-dependent first: protocol_usdc_summary reads market_usdc_flows,
-- which reads the two obligation views.
DROP VIEW IF EXISTS protocol_usdc_summary;
DROP VIEW IF EXISTS market_usdc_flows;
DROP VIEW IF EXISTS market_order_obligations;
DROP VIEW IF EXISTS market_locked_matches;
DROP VIEW IF EXISTS stale_settlements;
DROP VIEW IF EXISTS trader_open_exposure;
DROP VIEW IF EXISTS bets_view;

ALTER TABLE markets            ALTER COLUMN up_pool           TYPE NUMERIC(38, 18);
ALTER TABLE markets            ALTER COLUMN down_pool         TYPE NUMERIC(38, 18);
ALTER TABLE markets            ALTER COLUMN total_volume      TYPE NUMERIC(38, 18);
ALTER TABLE bets               ALTER COLUMN amount_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE bets               ALTER COLUMN payout_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE referrals          ALTER COLUMN bet_volume        TYPE NUMERIC(38, 18);
ALTER TABLE referrals          ALTER COLUMN earned_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE referral_earnings  ALTER COLUMN amount            TYPE NUMERIC(38, 18);
ALTER TABLE prob_snapshots     ALTER COLUMN up_pool           TYPE NUMERIC(38, 18);
ALTER TABLE prob_snapshots     ALTER COLUMN down_pool         TYPE NUMERIC(38, 18);
ALTER TABLE orders             ALTER COLUMN amount_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE orders             ALTER COLUMN filled_amount     TYPE NUMERIC(38, 18);
ALTER TABLE orders             ALTER COLUMN payout_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE matches            ALTER COLUMN amount_usdc       TYPE NUMERIC(38, 18);
ALTER TABLE order_matches      ALTER COLUMN matched_amount    TYPE NUMERIC(38, 18);
ALTER TABLE traders            ALTER COLUMN total_volume      TYPE NUMERIC(38, 18);
ALTER TABLE traders            ALTER COLUMN total_profit      TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN total_deposited  TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN total_claimed    TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN total_refunded   TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN expected_balance TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN actual_balance   TYPE NUMERIC(38, 18);
ALTER TABLE invariant_snapshots ALTER COLUMN drift_usdc       TYPE NUMERIC(38, 18);

-- ── 2. Markets without a close time ────────────────────────────────────────
-- close_time is not a contract concept and never was: OrderbookMarket has no
-- closeTime, expiry or marketEnd, and a match's settleAt is set when it
-- matches. The column exists because the keeper invented a rollover policy and
-- needed somewhere to record it.
--
-- On Robinhood Chain a market is created once per (pool, duration) and lives
-- forever, so there is nothing to put here. The base profile keeps writing it
-- and keeps its `WHERE status='OPEN' AND close_time > NOW()` query; making the
-- column nullable is what lets the other profile leave it alone rather than
-- inventing a far-future timestamp that would then have to be believed.
ALTER TABLE markets ALTER COLUMN close_time DROP NOT NULL;

-- Which chain a row came from. Existing rows are Base, and 8453 is the value
-- they would have carried had the column always existed.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 8453;

-- The pool's non-WETH token, for the rhc profile. Null on base, where a feed
-- is a symbol rather than a pair. Lets the UI link a market to the token
-- without decoding feed_id.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS token_address TEXT;

-- feed_id is the pool address on rhc and is looked up on every poolWatcher and
-- indexer tick; on base it was already queried without an index.
CREATE INDEX IF NOT EXISTS idx_markets_feed_id ON markets(feed_id);
CREATE INDEX IF NOT EXISTS idx_markets_chain_open ON markets(chain_id, status);

-- ── 3. Pools the keeper is deciding about ──────────────────────────────────
-- 496 pools are created on that chain every day and 292 of them pair with
-- WETH, so the watcher sees far more than it will ever onboard, and its
-- decisions are not instant: a pool can fail the depth gate at noon and pass
-- it at one. Without somewhere to write that down the watcher would either
-- re-derive every pool's state from chain on every tick, or forget the ones it
-- deferred.
--
-- `status` is the decision, `reason` is why - kept as free text on purpose, so
-- a log line and a row always say exactly the same thing.
CREATE TABLE IF NOT EXISTS pool_candidates (
  pool_address     TEXT PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  token_address    TEXT NOT NULL,
  token_symbol     TEXT,
  fee_tier         INTEGER NOT NULL,
  created_block    BIGINT NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- PENDING  seen, not yet fit
  -- READY    passes every gate, markets being created
  -- ONBOARDED every allowed duration has a market
  -- REJECTED permanently unfit (wrong pair, disallowed tier)
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'READY', 'ONBOARDED', 'REJECTED')),
  reason           TEXT,
  weth_depth       NUMERIC(38, 18),
  cardinality      INTEGER,
  -- Set once we have paid to grow the observation ring, so a restart does not
  -- pay twice. The single largest per-pool cost at ~6.7M gas.
  cardinality_paid_at TIMESTAMPTZ,
  last_checked_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_candidates_status ON pool_candidates(status, last_checked_at);

-- ── 4. The views, back exactly as they were ────────────────────────────────
-- Verbatim from 002 (bets_view), 003 (trader_open_exposure, stale_settlements)
-- and 004 (the four invariant views). Only the column types underneath them
-- have changed, and a view has no opinion about those.

CREATE OR REPLACE VIEW bets_view AS
SELECT
  o.market_address,
  o.order_id,
  o.trader_address,
  o.direction,
  o.amount_usdc,
  o.filled_amount,
  o.referrer_address,
  CASE
    WHEN o.status IN ('SETTLED', 'CLAIMED') AND COALESCE(o.payout_usdc, 0) > 0 THEN TRUE
    WHEN o.status IN ('SETTLED', 'CLAIMED') THEN FALSE
    ELSE NULL
  END                                    AS won,
  o.payout_usdc,
  (o.status = 'CLAIMED')                 AS claimed,
  o.placed_at,
  o.settled_at,
  o.feed_symbol
FROM orders o;

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

CREATE OR REPLACE VIEW market_locked_matches AS
SELECT
  market_address,
  COALESCE(SUM(CASE WHEN NOT settled THEN amount_usdc * 2 ELSE 0 END), 0) AS locked_in_matches
FROM matches
GROUP BY market_address;

CREATE OR REPLACE VIEW market_order_obligations AS
SELECT
  market_address,
  COALESCE(SUM(
    CASE WHEN status IN ('PENDING','MATCHED') AND NOT unmatched_refunded
         THEN amount_usdc - filled_amount ELSE 0 END
  ), 0) AS unmatched_held,
  COALESCE(SUM(
    CASE WHEN status IN ('MATCHED','SETTLED') THEN COALESCE(payout_usdc, 0) ELSE 0 END
  ), 0) AS unclaimed_payout,
  COALESCE(SUM(amount_usdc), 0)                                              AS total_deposited,
  COALESCE(SUM(CASE WHEN status = 'CLAIMED' THEN payout_usdc ELSE 0 END), 0) AS total_claimed,
  COALESCE(SUM(
    CASE WHEN status = 'REFUNDED' THEN amount_usdc
         WHEN unmatched_refunded  THEN amount_usdc - filled_amount
         ELSE 0 END
  ), 0)                                                                      AS total_refunded
FROM orders
GROUP BY market_address;

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

CREATE OR REPLACE VIEW protocol_usdc_summary AS
SELECT
  COUNT(*)                       AS markets,
  SUM(total_deposited)           AS total_deposited,
  SUM(total_claimed)             AS total_claimed,
  SUM(total_refunded)            AS total_refunded,
  SUM(expected_balance)          AS expected_onchain_balance
FROM market_usdc_flows;
