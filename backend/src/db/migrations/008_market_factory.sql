-- 008: which factory created a market.
--
-- Robinhood Chain is redeployed whenever the contracts change, and every
-- deployment leaves its markets behind in this table. Nothing recorded which
-- factory a row came from, so the API listed the markets of a factory the
-- product had already moved off (the frontend labels them "NOT A REAL
-- MARKET"), and the keeper kept scanning, pricing and refunding them.
--
-- The column is written by the indexer's MarketCreated handler from here on.
-- Rows that already exist keep NULL, and on the rhc profile NULL is read as
-- "not the current factory" (lib/marketScope.ts). Deliberately NO data change
-- in this migration: the same files run against the Base database, where
-- nothing may be closed, deleted or restamped by a schema step, and Base never
-- filters on this column. A market of the current factory that was indexed
-- before this ran is stamped by hand (see the deploy notes), or simply by
-- deploying the next factory, whose markets are indexed with the column set.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS factory_address TEXT;

CREATE INDEX IF NOT EXISTS idx_markets_factory ON markets(factory_address);
