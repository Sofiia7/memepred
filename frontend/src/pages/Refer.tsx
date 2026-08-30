/**
 * Refer page - Sprint 5.5 audit fix.
 *
 * Dedicated "invite friends" screen. Portfolio's ReferralPanel already
 * covers the connected-wallet case inline; this page is the deep-linkable
 * destination for it, and also renders the friends-referred list from
 * /api/referral/list/:address (built on the backend, never rendered
 * anywhere in the frontend until now).
 */
import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { useReferral } from '../hooks/useReferral'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { StarIcon } from '../components/ui/icons'
import { shortAddr } from '../lib/symbols'

const API = import.meta.env.VITE_API_URL

interface ReferredFriend {
  referee_address: string
  registered_at:   string
  volume:          string
  earned:          string
}

export function ReferPage() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const r = useReferral()

  const refLink = r.myCode && r.myCode !== '0x000000000000'
    ? `${window.location.origin}/?ref=${r.myCode}`
    : null
  const claimable = Number(r.claimableRewards ?? 0n) / 1e6

  const { data: friends } = useQuery<ReferredFriend[]>({
    queryKey: ['referral-list', address],
    queryFn: async () => {
      const res = await fetch(`${API}/api/referral/list/${address}`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!address,
    refetchInterval: 30_000,
  })

  return (
    <>
      <ScreenTitle title="Refer Friends" icon={<StarIcon color="#4d8dff" />} />

      <div className="genesis-hero">
        <div className="gh-eyebrow">
          <span className="basesq" />
          Earn on every friend you invite
        </div>
        <h3 className="gh-title">
          Get <em>40%</em> of the protocol fee your friends' bets generate.
        </h3>
        <div className="gh-sub">
          Share your link. Once someone bets using it, they're yours forever - you
          earn on their bets for as long as they trade on FlipTheMeme.
        </div>
        {/*
          Said plainly because it is currently the whole story: the protocol fee
          is 0% today, so a referral earns nothing yet. The 1% charged when you
          beat the LP pool is not the protocol fee - it goes to the pool and
          never reaches a referrer. Promising "40% of every bet" while the real
          number is zero is the kind of thing this project has already decided
          not to do about the audit and the cap.
        */}
        <div className="gh-sub" style={{ marginTop: 8, opacity: 0.75 }}>
          Worth knowing: the protocol fee is <b>0% right now</b>, so referrals
          currently earn nothing. Peer-matched bets carry no protocol fee at all.
          Your link keeps working, and starts paying if and when a fee is
          switched on - the live rate is always in the contract.
        </div>
      </div>

      {!isConnected ? (
        <button className="cta" onClick={connectWallet}>
          <span className="basesq" />
          CONNECT WALLET TO GET YOUR LINK
        </button>
      ) : (
        <>
          <StatStrip
            items={[
              { k: 'Friends Referred', v: String(Number(r.myReferralCount ?? 0n)) },
              { k: 'Claimable', v: `$${claimable.toFixed(2)}`, tone: claimable > 0 ? 'up' : undefined },
            ]}
          />

          <div className="b-title">Your invite link</div>
          {refLink ? (
            <div className="stake-input" style={{ marginBottom: 10 }}>
              <span className="ccy" style={{ marginRight: 6, fontSize: 10 }}>LINK</span>
              <input readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 10 }} />
            </div>
          ) : (
            <button className="cta" style={{ marginBottom: 10 }} onClick={r.generateMyCode} disabled={r.busy}>
              {r.busy ? <span className="spinner" /> : <span className="basesq" />}
              GENERATE MY LINK
            </button>
          )}

          {claimable > 0 && (
            <button className="cta" style={{ marginBottom: 14 }} onClick={r.claimRewards} disabled={r.busy}>
              {r.busy ? <span className="spinner" /> : <span className="basesq" />}
              CLAIM ${claimable.toFixed(2)}
            </button>
          )}

          <div className="b-title">Friends you've referred</div>
          {!friends?.length ? (
            <div className="empty-state">No referrals yet - share your link above</div>
          ) : (
            <div className="lb-list">
              {friends.map((f) => (
                <div key={f.referee_address} className="lb-row" style={{ gridTemplateColumns: '1fr auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="lb-name">{shortAddr(f.referee_address)}</div>
                    <div className="lb-sub">${Number(f.volume).toFixed(0)} volume</div>
                  </div>
                  <div className="lb-pnl">+${Number(f.earned).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ height: 24 }} />
    </>
  )
}
