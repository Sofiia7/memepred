import { useState } from 'react'
import { useAccount } from 'wagmi'
import { CURRENCY_DECIMALS, CURRENCY_SYMBOL, IS_POOL_BACKED } from '../lib/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { type Address } from 'viem'
import { formatUnits } from 'viem'
import { useOrderActions } from '../hooks/useOrderActions'
import { useReferral } from '../hooks/useReferral'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { TxStatus } from '../components/TxStatus'
import { BadgeGrid } from '../components/BadgeGrid'
import { WalletIcon, Chev } from '../components/ui/icons'
import { symbolMeta, shortAddr } from '../lib/symbols'
import {
  BET_OUTCOME_LABEL,
  betAtRisk,
  betOutcome,
  betPayout,
  betStake,
  betUnmatched,
  isClaimableBet,
  type BetLike,
} from '../lib/portfolioModel'
import '../order.css'

const API = import.meta.env.VITE_API_URL

function money(value: number, decimals = 2): string {
  return IS_POOL_BACKED
    ? `${value.toFixed(decimals)} ${CURRENCY_SYMBOL}`
    : `$${value.toFixed(decimals)}`
}

const DECIMALS = IS_POOL_BACKED ? 4 : 2

type Bet = BetLike & {
  market_address: Address
  match_id:       string | null
  direction:      'UP' | 'DOWN'
  placed_at:      string
  settled_at:     string | null
  feed_symbol:    string
}

interface Profile {
  address:       string
  totalBets:     number
  wonBets:       number
  accuracy:      number
  totalVolume:   number
  profit:        number
  currentStreak: number
  maxStreak:     number
  badges:        { badge_id: number; minted_at: string }[]
  recentBets:    Bet[]
}

type Actions = ReturnType<typeof useOrderActions>

/** A button that lives inside a row that is itself a link: it must not navigate. */
function RowButton({ label, busy, disabled, onClick, title }: {
  label: string
  busy: boolean
  disabled: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      className="cta row-action"
      style={{ padding: '8px 12px', fontSize: 11, height: 'auto', width: 'auto' }}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        // Row itself is a Link to /order/...; acting from here shouldn't navigate.
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
    >
      {busy ? <span className="spinner" /> : null}
      {label}
    </button>
  )
}

function BetRow({ bet, actions, doneKeys }: { bet: Bet; actions: Actions; doneKeys: Set<string> }) {
  const meta = symbolMeta(bet.feed_symbol)
  const isUp = bet.direction === 'UP'
  const orderId = bet.order_id ? BigInt(bet.order_id) : null

  const stake = betStake(bet)
  const atRisk = betAtRisk(bet)
  const payout = betPayout(bet)
  const unmatched = betUnmatched(bet)
  // One word for the whole order (audit U08): "WON" used to be printed as soon
  // as a single match won, whatever the rest of the order did. The order page
  // draws the same conclusion from the same fields, with the per-match list.
  const outcome = betOutcome(bet)

  const key = (kind: 'claim' | 'cancel') => `${kind}:${bet.market_address.toLowerCase()}:${bet.order_id}`
  const canClaim = orderId !== null && isClaimableBet(bet) && !doneKeys.has(key('claim'))
  const canCancel = orderId !== null && unmatched > 0 && !doneKeys.has(key('cancel')) && !canClaim

  // Which row an in-flight or finished transaction belongs to: the hook is
  // shared by the whole list, so its state says which order it was about.
  const here =
    orderId !== null &&
    actions.state.market?.toLowerCase() === bet.market_address.toLowerCase() &&
    actions.state.id === orderId
  const busyHere = here && actions.isPending

  // What the second line says, with the same terms and numbers as the order
  // page: "at risk" is the filled part, "payout" is what the order accrued.
  const detail =
    outcome === 'open'
      ? atRisk > 0
        ? `${money(atRisk, DECIMALS)} of ${money(stake, DECIMALS)} matched`
        : 'waiting for a match'
      : outcome === 'tie' || outcome === 'refunded'
        // The whole deposit came back: a REFUNDED order that never matched has
        // filled_amount 0, and "0 returned" would be wrong.
        ? `${money(stake, DECIMALS)} returned`
        : `at risk ${money(atRisk, DECIMALS)} · payout ${money(payout ?? 0, DECIMALS)}`

  const rowContent = (
    <>
      <div className={'coin-icon ' + meta.iconClass} style={{ width: 26, height: 26, fontSize: 10 }}>{meta.glyph}</div>
      <div style={{ minWidth: 0 }}>
        <div className="lb-name">
          <span className={'pick-pill ' + (isUp ? 'up' : 'dn')} style={{ marginRight: 6, padding: '2px 6px', fontSize: 9 }}>
            <Chev dir={isUp ? 'up' : 'down'} /> {bet.direction}
          </span>
          {bet.feed_symbol} · {money(stake, DECIMALS)}
        </div>
        <div className="bet-sub">
          <span className={'bet-outcome bet-outcome-' + outcome}>{BET_OUTCOME_LABEL[outcome]}</span>
          {' · '}{detail}
        </div>
      </div>
      {canClaim ? (
        <RowButton
          label="CLAIM"
          busy={busyHere}
          disabled={actions.isPending}
          onClick={() => void actions.claim(orderId!, bet.market_address)}
        />
      ) : canCancel ? (
        <RowButton
          label="CANCEL REST"
          busy={busyHere}
          disabled={actions.isPending}
          title={`Take back the ${money(unmatched, DECIMALS)} that has not found a match`}
          onClick={() => void actions.cancel(orderId!, bet.market_address)}
        />
      ) : (
        <span />
      )}
      <div className={'lb-pnl ' + (outcome === 'loss' ? 'dn' : '')}>
        {payout !== null ? money(payout, DECIMALS) : '-'}
      </div>
    </>
  )

  // Every bet with an on-chain order_id has a status page - link to it so
  // "pending" bets are actually trackable instead of a dead-end list row.
  const row = bet.order_id ? (
    <Link
      to={`/order/${bet.market_address}/${bet.order_id}`}
      className="lb-row"
      style={{ gridTemplateColumns: '32px 1fr auto auto', textDecoration: 'none', color: 'inherit' }}
    >
      {rowContent}
    </Link>
  ) : (
    <div className="lb-row" style={{ gridTemplateColumns: '32px 1fr auto auto' }}>
      {rowContent}
    </div>
  )

  return (
    <div className="bet-item">
      {row}
      {/* The receipt state of a claim or cancel started from this row, with the
          reason when it failed: this page used to drop the error entirely. */}
      {here && <TxStatus state={actions.state} compact />}
    </div>
  )
}

function ReferralPanel() {
  const r = useReferral()
  const refLink = r.myCode && r.myCode !== '0x000000000000'
    ? `${window.location.origin}/?ref=${r.myCode}`
    : null
  const claimable = Number(formatUnits(r.claimableRewards ?? 0n, CURRENCY_DECIMALS))
  const displayAmount = money(claimable, DECIMALS)

  return (
    <>
      <div className="b-title" style={{ justifyContent: 'space-between' }}>
        Referrals
        <Link to="/refer" style={{ fontSize: 10, color: 'var(--base-blue-2)', textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>
          View all →
        </Link>
      </div>
      <StatStrip
        items={[
          { k: 'Friends Referred', v: String(Number(r.myReferralCount ?? 0n)) },
          { k: 'Claimable', v: displayAmount, tone: claimable > 0 ? 'up' : undefined },
        ]}
      />
      {refLink ? (
        <div className="stake-input" style={{ marginBottom: 10 }}>
          <span className="ccy" style={{ marginRight: 6, fontSize: 10 }}>LINK</span>
          <input readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 10 }} />
        </div>
      ) : (
        <button className="cta" style={{ marginBottom: 10 }} onClick={r.generateMyCode} disabled={r.busy}>
          <span className="basesq" />
          GENERATE CODE
        </button>
      )}
      {claimable > 0 && (
        <button className="cta" style={{ marginBottom: 14 }} onClick={r.claimRewards} disabled={r.busy}>
          {r.busy ? <span className="spinner" /> : <span className="basesq" />}
          CLAIM {displayAmount}
        </button>
      )}
    </>
  )
}

export function Portfolio() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()

  const { data: profile, isLoading, isError, refetch } = useQuery<Profile>({
    queryKey: ['profile', address],
    queryFn: async () => {
      const res = await fetch(`${API}/api/profile/${address}`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!address,
    refetchInterval: 30_000,
    retry: 2,
  })

  // Rows whose claim or cancel has been confirmed on chain this session. The
  // profile is served from an indexer that trails the chain (and a 30 second
  // cache), so for a while the API still lists a claimed order as claimable;
  // this is what keeps CLAIM from coming back for money that is already paid.
  const [doneKeys, setDoneKeys] = useState<Set<string>>(() => new Set())

  // ONE hook for every row: only one transaction at a time, wherever it was
  // started, and the market travels with each call. It follows the transaction
  // to the receipt, then refetches the profile.
  const actions = useOrderActions(undefined, {
    onConfirmed: ({ action, market, id }) => {
      const kind = action === 'claim' ? 'claim' : action === 'cancelOrder' ? 'cancel' : null
      if (kind) setDoneKeys((prev) => new Set(prev).add(`${kind}:${market.toLowerCase()}:${id}`))
      void refetch()
    },
  })

  if (!isConnected) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state" style={{ marginBottom: 16 }}>Connect wallet to view your stats</div>
        <button className="cta" onClick={connectWallet}>
          <span className="basesq" />
          CONNECT WALLET
        </button>
      </>
    )
  }

  if (isError) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state">Couldn't load your profile. The API may be temporarily unavailable.</div>
        <button className="cta" onClick={() => refetch()}>
          <span className="basesq" />
          RETRY
        </button>
      </>
    )
  }

  if (isLoading || !profile) {
    return (
      <>
        <ScreenTitle title="Portfolio" icon={<WalletIcon />} />
        <div className="empty-state">Loading profile…</div>
      </>
    )
  }

  const ownedBadgeIds = new Set((profile.badges ?? []).map((b) => b.badge_id))
  // Same rule as each row's CLAIM button (lib/portfolioModel). It used to be
  // "status is SETTLED and won", which left out a REFUNDED order that still held
  // the winnings of another match, and listed an order as claimable once any
  // match had won.
  const claimable = profile.recentBets.filter(
    (b) => isClaimableBet(b) && !doneKeys.has(`claim:${b.market_address.toLowerCase()}:${b.order_id}`),
  )

  return (
    <>
      <ScreenTitle title="Portfolio" icon={<WalletIcon />} live liveLabel={shortAddr(address)} liveColor="var(--up)" />

      <StatStrip
        items={[
          { k: 'Profit', v: `${profile.profit >= 0 ? '+' : '−'}${money(Math.abs(profile.profit), DECIMALS)}`, tone: profile.profit >= 0 ? 'up' : 'dn' },
          // Same name and same meaning as the leaderboard's "WR": orders that
          // won at least one match, out of the orders that have a result.
          { k: 'Win rate', v: `${profile.accuracy}%`, u: `${profile.wonBets}/${profile.totalBets} settled` },
        ]}
      />
      <StatStrip
        items={[
          { k: 'Volume', v: money(profile.totalVolume, IS_POOL_BACKED ? 4 : 0) },
          { k: 'Streak', v: `🔥 ${profile.currentStreak}`, u: `max ${profile.maxStreak}` },
        ]}
      />

      {claimable.length > 0 && (
        <>
          <div className="b-title">Ready to claim ({claimable.length})</div>
          <div className="lb-list" style={{ marginBottom: 14 }}>
            {claimable.map((b) => (
              <BetRow key={`${b.market_address}:${b.order_id}`} bet={b} actions={actions} doneKeys={doneKeys} />
            ))}
          </div>
        </>
      )}

      <ReferralPanel />

      <div className="b-title">Badges</div>
      <BadgeGrid ownedIds={ownedBadgeIds} />

      <div className="b-title" style={{ marginTop: 16 }}>Recent bets</div>
      {profile.recentBets.length === 0 ? (
        <div className="empty-state">No bets yet</div>
      ) : (
        <div className="lb-list">
          {profile.recentBets.map((b, i) => (
            <BetRow key={b.order_id ? `${b.market_address}:${b.order_id}` : i} bet={b} actions={actions} doneKeys={doneKeys} />
          ))}
        </div>
      )}

      <div style={{ height: 24 }} />
    </>
  )
}
