-- Track the on-chain order_id so the frontend can call market.claim(orderId).
ALTER TABLE bets ADD COLUMN IF NOT EXISTS order_id BIGINT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS match_id BIGINT;
CREATE INDEX IF NOT EXISTS bets_order_idx  ON bets(market_address, order_id);
CREATE INDEX IF NOT EXISTS bets_trader_idx ON bets(trader_address, won, claimed);
