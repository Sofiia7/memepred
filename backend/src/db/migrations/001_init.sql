-- Расширения
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Цены монет (TimescaleDB hypertable для быстрых запросов)
CREATE TABLE price_history (
  id          BIGSERIAL,
  feed_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  price       NUMERIC(30, 18) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('price_history', 'recorded_at');
CREATE INDEX ON price_history (feed_id, recorded_at DESC);

-- Рынки (синхронизируется из The Graph)
CREATE TABLE markets (
  market_address TEXT PRIMARY KEY,
  feed_id        TEXT NOT NULL,
  feed_symbol    TEXT NOT NULL,
  duration_secs  INTEGER NOT NULL,
  open_time      TIMESTAMPTZ NOT NULL,
  close_time     TIMESTAMPTZ NOT NULL,
  entry_price    NUMERIC(30, 18),
  exit_price     NUMERIC(30, 18),
  status         TEXT NOT NULL DEFAULT 'OPEN',
  up_won         BOOLEAN,
  up_pool        NUMERIC(20, 6) DEFAULT 0,
  down_pool      NUMERIC(20, 6) DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Ставки
CREATE TABLE bets (
  id              BIGSERIAL PRIMARY KEY,
  market_address  TEXT NOT NULL REFERENCES markets(market_address),
  trader_address  TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  amount_usdc     NUMERIC(20, 6) NOT NULL,
  referrer_address TEXT,
  won             BOOLEAN,
  payout_usdc     NUMERIC(20, 6),
  claimed         BOOLEAN DEFAULT FALSE,
  placed_at       TIMESTAMPTZ NOT NULL,
  settled_at      TIMESTAMPTZ,
  feed_symbol     TEXT NOT NULL,
  current_streak  INTEGER DEFAULT 0
);
CREATE INDEX ON bets (trader_address, settled_at DESC);
CREATE INDEX ON bets (market_address);

-- Рефералы
CREATE TABLE referrals (
  referrer_address TEXT NOT NULL,
  referee_address  TEXT NOT NULL UNIQUE,
  registered_at    TIMESTAMPTZ DEFAULT NOW(),
  bet_volume       NUMERIC(20, 6) DEFAULT 0,
  earned_usdc      NUMERIC(20, 6) DEFAULT 0,
  PRIMARY KEY (referrer_address, referee_address)
);

CREATE TABLE ref_codes (
  code             TEXT PRIMARY KEY,
  referrer_address TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE referral_earnings (
  id               BIGSERIAL PRIMARY KEY,
  referrer_address TEXT NOT NULL,
  referee_address  TEXT NOT NULL,
  market_address   TEXT NOT NULL,
  amount           NUMERIC(20, 6) NOT NULL,
  claimed          BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Снапшоты вероятности
CREATE TABLE prob_snapshots (
  id             BIGSERIAL,
  market_address TEXT NOT NULL,
  up_pool        NUMERIC(20, 6) DEFAULT 0,
  down_pool      NUMERIC(20, 6) DEFAULT 0,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('prob_snapshots', 'snapshot_at');

-- Стрики
CREATE TABLE trader_streaks (
  trader_address TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  max_streak     INTEGER DEFAULT 0,
  last_bet_date  DATE,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- NFT бейджи
CREATE TABLE minted_badges (
  trader_address TEXT NOT NULL,
  badge_id       INTEGER NOT NULL,
  tx_hash        TEXT,
  minted_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trader_address, badge_id)
);
