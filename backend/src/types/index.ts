export interface MarketRow {
  market_address: string
  feed_id:        string
  feed_symbol:    string
  duration_secs:  number
  open_time:      string
  close_time:     string
  entry_price:    string
  exit_price:     string | null
  status:         'OPEN' | 'CLOSED' | 'RESOLVED' | 'REFUNDED'
  up_won:         boolean | null
  up_pool:        string
  down_pool:      string
}

export interface BetRow {
  id:               number
  market_address:   string
  trader_address:   string
  direction:        'UP' | 'DOWN'
  amount_usdc:      string
  referrer_address: string | null
  won:              boolean | null
  payout_usdc:      string | null
  claimed:          boolean
  placed_at:        string
  settled_at:       string | null
  feed_symbol:      string
  current_streak:   number
}

export interface Candle {
  time:  number
  open:  number
  high:  number
  low:   number
  close: number
}

export interface ProbPoint {
  ts:     number
  upPct:  number
  upPool: number
  dnPool: number
}
