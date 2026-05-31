-- =============================================================
-- Sprint 3.1 — orderbook DB schema (orders + matches + order_matches)
--
-- The original `bets` table from 001 conflated orders, matches, and
-- settlements into a single row. After the OrderbookMarket refactor
-- (Sprint 1.1) each placeBet can be matched into N partial matches
-- with different counterparties or the LP pool. We need separate
-- rows for orders and matches with a many-to-many join.
--
-- `bets` from 001 stays as a (now-deprecated) write-through table the
-- old code can still read while routes are migrated piecewise. New
-- code MUST use orders/matches/order_matches.
-- =============================================================

-- ── Orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  market_address      TEXT NOT NULL,
  order_id            BIGINT NOT NULL,
  trader_address      TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  amount_usdc         NUMERIC(20, 6) NOT NULL,
  filled_amount       NUMERIC(20, 6) NOT NULL DEFAULT 0,
  referrer_address    TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','MATCHED','SETTLED','CLAIMED','REFUNDED')),
  placed_at           TIMESTAMPTZ NOT NULL,
  matched_at          TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  claimed_at          TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  unmatched_refunded  BOOLEAN NOT NULL DEFAULT FALSE,
  payout_usdc         NUMERIC(20, 6),
  feed_symbol         TEXT NOT NULL,
  placed_tx           TEXT,
  PRIMARY KEY (market_address, order_id)
);
CREATE INDEX IF NOT EXISTS orders_trader_status_idx
  ON orders (trader_address, status);
CREATE INDEX IF NOT EXISTS orders_market_status_idx
  ON orders (market_address, status);

-- ── Matches ──────────────────────────────────────────────────
-- A match is a unit of risk: amount × 2 USDC locked, settled to one side.
-- For LP matches, either up_order_id or down_order_id is NULL (the LP took
-- that side); user_order_id is the user's side, kept for fast lookup.
CREATE TABLE IF NOT EXISTS matches (
  market_address  TEXT NOT NULL,
  match_id        BIGINT NOT NULL,
  is_lp_match     BOOLEAN NOT NULL,
  up_order_id     BIGINT,
  down_order_id   BIGINT,
  user_order_id   BIGINT,
  amount_usdc     NUMERIC(20, 6) NOT NULL,
  entry_price     NUMERIC(40, 18) NOT NULL,
  exit_price      NUMERIC(40, 18),
  matched_at      TIMESTAMPTZ NOT NULL,
  settle_at       TIMESTAMPTZ NOT NULL,
  settled_at      TIMESTAMPTZ,
  up_won          BOOLEAN,
  settled         BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (market_address, match_id)
);
CREATE INDEX IF NOT EXISTS matches_market_settled_idx
  ON matches (market_address, settled, settle_at);

-- ── Order ⨯ Match join (multi-fill) ──────────────────────────
CREATE TABLE IF NOT EXISTS order_matches (
  market_address  TEXT NOT NULL,
  order_id        BIGINT NOT NULL,
  match_id        BIGINT NOT NULL,
  matched_amount  NUMERIC(20, 6) NOT NULL,
  PRIMARY KEY (market_address, order_id, match_id),
  FOREIGN KEY (market_address, order_id) REFERENCES orders        (market_address, order_id) ON DELETE CASCADE,
  FOREIGN KEY (market_address, match_id) REFERENCES matches       (market_address, match_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS order_matches_match_idx
  ON order_matches (market_address, match_id);

-- ── Markets schema extension ─────────────────────────────────
-- The factory tracks markets per (feedId × duration). The original 001
-- table doesn't have these; add them idempotently for new code.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS total_orders   BIGINT       NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS total_matches  BIGINT       NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS total_volume   NUMERIC(28,6) NOT NULL DEFAULT 0;

-- ── Trader aggregates ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traders (
  trader_address    TEXT PRIMARY KEY,
  total_orders      BIGINT          NOT NULL DEFAULT 0,
  won_orders        BIGINT          NOT NULL DEFAULT 0,
  refunded_orders   BIGINT          NOT NULL DEFAULT 0,
  total_volume      NUMERIC(28, 6)  NOT NULL DEFAULT 0,
  total_profit      NUMERIC(28, 6)  NOT NULL DEFAULT 0,
  current_streak    INTEGER         NOT NULL DEFAULT 0,
  max_streak        INTEGER         NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexer cursor (one row per stream) ──────────────────────
-- Keeper's event indexer remembers where it was per (factory|orderbook|referrals).
-- Idempotent INSERT via ON CONFLICT (market_address, log_id) keeps event ingestion safe to replay.
CREATE TABLE IF NOT EXISTS _indexer_cursor (
  stream      TEXT PRIMARY KEY,
  last_block  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Deduplication of event ingestion ─────────────────────────
-- Used as an "I've seen this log" set, so reorgs that replay events
-- don't double-write into orders/matches/order_matches.
CREATE TABLE IF NOT EXISTS _ingested_logs (
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  ingested_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index)
);

-- ── Compatibility VIEW ───────────────────────────────────────
-- Legacy routes / services that still read from `bets` keep working via
-- this view. Each order maps to one row; "won" is derived from payout.
-- New code SHOULD prefer querying orders/matches directly.
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
