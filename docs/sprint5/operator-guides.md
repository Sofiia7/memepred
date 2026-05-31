# Operator guides — Sprint 5 third-party setup

Three things only you can do (they require an interactive browser session,
account signing, or org membership). Each is documented end-to-end here.

---

## 1. Farcaster Mini App — `accountAssociation` signing

The mini-app manifest at `frontend/public/.well-known/farcaster.json`
currently has placeholder `accountAssociation` values. Until you sign and
paste real ones, Warpcast will refuse to render the app as a mini-app
(falls back to a plain webpage).

### Pre-reqs

- A Farcaster account (FID). Connect to Warpcast or any FC client.
- Custody wallet for that FID. This is the wallet that originally
  registered the FID — not your everyday wallet. Find it in Warpcast →
  Settings → Account → "Custody address".
- The custody wallet's seed phrase or hardware-wallet access for signing.
- Your final production domain — **the signature is domain-bound**. If
  you sign for `staging.memepred.xyz` and serve from `memepred.xyz`, it
  fails. Sign once you have your real domain pointed at the Vercel /
  Cloudflare deploy.

### Steps

1. **Open the dev tool.**
   Go to <https://farcaster.xyz/~/developers/mini-apps/manifest>
   (or from Warpcast: ⋮ → Developers → Mini Apps → Manifest tool).
   You'll need to log in with your FID.

2. **Enter your domain** in the "Domain" field — just the host part,
   e.g. `memepred.xyz` (no scheme, no path).

3. **Connect the custody wallet.** The tool will prompt for the
   `signTypedData` payload (EIP-712). The structure is:

   ```jsonc
   {
     "domain": { "name": "Farcaster Frame", "version": "1" },
     "primaryType": "Frame",
     "message": {
       "domain": "memepred.xyz"
     }
   }
   ```

4. **Sign.** The tool returns three base64url-encoded blobs:

   - `header`  — describes the FID and signing wallet
   - `payload` — the domain claim
   - `signature` — the actual signature

5. **Paste into the manifest.** Open
   `frontend/public/.well-known/farcaster.json` and replace the three
   `REPLACE_WITH_…` strings in both the `accountAssociation` block and
   delete the placeholder `_comment` line. The `miniapp` block can stay
   as-is — only the association needs your signature.

6. **Verify.** After your next deploy:

   ```bash
   curl https://memepred.xyz/.well-known/farcaster.json | jq .
   ```

   The accountAssociation block should be your three base64 strings.
   Then validate in the dev tool's "Verify" tab — green checkmark = ok.

7. **Test in Warpcast preview**:
   <https://farcaster.xyz/~/developers/mini-apps/preview?url=https://memepred.xyz>

### Common pitfalls

- **Signing with the wrong wallet.** Must be the FID custody wallet.
  Smart-wallet FIDs need to use the EOA that registered them.
- **Wrong domain.** If you set `iconUrl` and `homeUrl` to
  `https://memepred.xyz/...` but signed for `dev.memepred.xyz`, mini-app
  validation fails silently. Re-sign with the matching host.
- **Caching.** Warpcast caches the manifest aggressively. Add `?bust=$(date +%s)`
  to the preview URL to force refetch while iterating.

---

## 2. Discord webhook — for Tenderly + keeper alerts

Five-minute setup. The output is one URL you paste into Tenderly and
into the backend `.env` as `DISCORD_WEBHOOK_URL`.

### Steps

1. **Open Discord, go to your server.** If you don't have one, create
   one — Server → Add a Server → "Create my own" → invite-only is fine.

2. **Pick a channel for alerts.** Name it `#memepred-alerts` so it's
   obvious. Right-click the channel → Edit Channel → Integrations →
   Webhooks → **New Webhook**.

3. **Configure**: name "MemePred Tenderly" (or whatever), avatar
   optional. Click **Copy Webhook URL**. It looks like:

   ```
   https://discord.com/api/webhooks/1234.../abcdef...
   ```

   **Treat this like a password** — anyone with the URL can post to the
   channel. Add it as a secret, do not commit.

4. **Smoke-test from your laptop**:

   ```bash
   curl -X POST -H 'Content-Type: application/json' \
     -d '{"content":"smoke test from MemePred ops"}' \
     "$DISCORD_WEBHOOK_URL"
   ```

   You should see the message in `#memepred-alerts` within 1 second.

5. **Put it where it's needed:**

   - `tenderly-alerts.yaml` → `deliveryChannels.discord.url`
   - `.env` (backend) → `DISCORD_WEBHOOK_URL` (if you wire it into
     `oracleWatchdog` later for ETH-low pages)

### Want a separate channel per severity?

Repeat steps 2-4 with a `#memepred-critical` channel, and reference
that webhook for the `critical`-tagged alerts in
`tenderly-alerts.yaml`. PagerDuty is the better channel for true
3am-wake-up criticals — see step 3 below.

---

## 3. Tenderly project ID — and importing alerts

The alerts YAML at `deploy/tenderly-alerts.yaml` is parameterized; you
need a Tenderly project to import it into.

### Steps

1. **Create a Tenderly account** at <https://dashboard.tenderly.co/register>
   if you don't have one. Free tier is fine for Sprint 5 soak.

2. **Create a project**:

   - Dashboard → "+ Create project"
   - Name: `memepred`
   - Network: Base (Tenderly supports both Sepolia and mainnet under
     the same project — you switch at alert level)

3. **Note the project slug.** It's in your URL:

   ```
   https://dashboard.tenderly.co/<account-slug>/<project-slug>/overview
   ```

   You'll need `<account-slug>` and `<project-slug>` when calling the
   Tenderly API. Save them as env vars locally:

   ```bash
   TENDERLY_ACCOUNT=your-account-slug
   TENDERLY_PROJECT=memepred
   ```

4. **Add the deployed contracts** as monitored addresses. After running
   `Deploy.s.sol` (Sprint 5.1), copy each contract address from the
   console output, then in Tenderly:

   - Project → Contracts → "+ Add Contract" → Verify on Etherscan tab
   - Paste address, network (Base Sepolia), Tenderly auto-fetches the ABI

   Add: `MarketFactory`, `OracleResolver`, `LiquidityPool`,
   `FeeDistributor`, `BadgeNFT`, `GenesisNFT`. You don't need to add
   individual OrderbookMarket clones — Tenderly picks them up via the
   `anyContract: true` filter in the alerts YAML.

5. **Connect a delivery channel.** In Tenderly:

   - Settings → Alerting → Notification Channels → "+ Add" → Discord
   - Paste your webhook URL from Section 2.
   - Test → expect a Tenderly hello message in `#memepred-alerts`.

6. **Import the alerts manifest:**

   The Tenderly UI doesn't have a direct "import YAML" button as of
   writing. Two options:

   **Option A (UI, per alert):** Use `deploy/tenderly-alerts.yaml` as a
   reference and create each one manually. For each:

   - Alerts → "+ New Alert" → Event Emitted
   - Contract: pick from your monitored list, or "Any contract" for the
     `anyContract: true` entries
   - Event: paste the event signature from the YAML
   - Add filter expressions where the YAML has `condition:`
   - Channel: Discord (your webhook)

   **Option B (API):** Use the Tenderly API to POST each alert. Their
   API docs are at `https://docs.tenderly.co/alerts/web3-actions`.
   I haven't scripted this because the API requires interactive
   account-token generation; if you want me to write the
   `import-alerts.mjs` script later, paste your Tenderly API token and
   I'll wire it.

7. **Setup PagerDuty integration for `critical` alerts.**

   Tenderly → Settings → Notification Channels → "+ Add" → PagerDuty.
   You need a PagerDuty account (14-day free trial enough for the soak)
   and a service "Integration Key" (Events API v2). PagerDuty UI:

   - Services → "+ New Service" → name "MemePred prod"
   - Integrations → "+ Add" → "Events API v2"
   - Copy the Integration Key (32-char hex)
   - Paste into Tenderly → that's `${PAGERDUTY_KEY}` in the YAML

   Once paired, the 3 alerts tagged `delivery: [discord, pagerduty]`
   will page on-call during the soak.

8. **Verify it all works.** From the deployer wallet (still has admin
   access until handoff, or use multisig stand-in):

   ```bash
   # Manually trigger a Paused event on one market for testing
   cast send <SOME_MARKET> "pause()" \
     --rpc-url https://sepolia.base.org \
     --private-key $MULTISIG_STANDIN_KEY
   ```

   Within 60 seconds: Discord ping AND a PagerDuty incident. Acknowledge
   the incident and unpause the test market to clean up.

---

## Cheat sheet

| What you need | Where to get it | Format | Lives where |
|---|---|---|---|
| Farcaster `accountAssociation` | Warpcast Dev → Mini Apps → Manifest tool | `{header, payload, signature}` base64 triple | `frontend/public/.well-known/farcaster.json` |
| Discord webhook URL | Discord channel → Integrations → Webhooks | `https://discord.com/api/webhooks/...` | Tenderly UI + maybe `.env` |
| Tenderly account-slug | Dashboard URL `dashboard.tenderly.co/<this>/...` | string | local env var |
| Tenderly project-slug | Dashboard URL `.../<account>/<this>/overview` | string | local env var |
| PagerDuty Integration Key | Service → Integrations → Events API v2 | 32-char hex | Tenderly UI |
