# FlipTheMeme — single-VPS deployment

Everything (Postgres + Redis + API + keeper + HTTPS reverse proxy) runs in one
`docker compose` stack on a single VPS. Tested on Ubuntu 22.04 / 24.04, 2 vCPU
/ 4 GB RAM (Hetzner CX22, ~€5/month).

## 1. Provision the VPS

```bash
# fresh Ubuntu 22.04/24.04
sudo apt update && sudo apt -y upgrade
sudo apt -y install docker.io docker-compose-v2 git ufw
sudo usermod -aG docker $USER && newgrp docker

# basic firewall — only SSH/HTTP/HTTPS
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Clone + configure

```bash
git clone https://github.com/YOU/flipthememe.git ~/flipthememe
cd ~/flipthememe/deploy
cp .env.example .env
# Edit .env — fill contract addresses (after forge deploy), passwords, keys.
```

Generate random secrets:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
echo "WORKER_SECRET=$(openssl rand -hex 24)"
```

## 3. DNS

Point `api.flipthememe.com` A/AAAA record to your VPS IP via Cloudflare.
Set Cloudflare proxy to "DNS-only" (grey cloud) so Caddy can grab Let's Encrypt
certs directly. After certs are issued, you can enable the orange cloud.

## 4. Boot

```bash
cd ~/flipthememe/deploy
docker compose up -d
docker compose logs -f
```

First boot:
- `backend` runs the migration runner, creating tables in Postgres.
- `keeper` starts six loops (price/30s on/off-chain, snapshots/60s, indexer/45s,
  resolver/60s, refund/5m).
- `caddy` requests Let's Encrypt cert for `API_DOMAIN`.

Health check:

```bash
curl https://api.flipthememe.com/health
# {"status":"ok","ts":1737...}
```

## 5. Backups

Hourly Postgres dumps via cron — drops the gzipped SQL into
`/var/backups/flipthememe`, keeps last 30 days.

```bash
crontab -e
# add:
0 * * * * /home/USER/flipthememe/deploy/scripts/backup-db.sh >> /var/log/flipthememe-backup.log 2>&1
```

For real off-site backup later, point a nightly job at `rclone copy` to
Cloudflare R2 / Backblaze B2 (cheap object storage).

## 6. Updates

```bash
cd ~/flipthememe
git pull
cd deploy
docker compose build --pull
docker compose up -d
```

## 7. Funding the keeper

The keeper hot wallet (`KEEPER_PRIVATE_KEY`) needs ETH on Base to pay gas for
on-chain price updates and resolver calls. Top up via Coinbase / Base bridge:

- Initial: **0.05 ETH** (≈ $130 worth, lasts ~2–3 months under light load).
- Monitor via the Basescan link in `~/flipthememe/deploy/MONITORING.md`.

The `OracleResolver` contract has a `receive() payable` and pays Pyth update fees
out of its own ETH balance — top it up directly (send ETH to its address):

- Initial: **0.02 ETH** is fine for months at the default 30s recording interval.

## 8. Monitoring (free)

**Do not point a monitor at `/health`.** It returns `{status:'ok'}` for as long
as the Fastify process has a pulse, which is why the August 2026 outage - a dead
keeper, no settlements, no price pushes - sat behind a green UptimeRobot check
for 15 days. A monitor aimed at a probe that cannot fail is worse than no
monitor, because it is believed.

Watch one of these instead:

| URL | goes red when |
|---|---|
| `https://api.flipthememe.com/health/deep` | keeper out of gas, watchdog snapshot stale (5 min), USDC invariant drift |
| `https://flipthememe-watchdog.sofiaseremeteva.workers.dev/` | any of the above, **or** the API or frontend is down, **or** the watchdog itself stopped ticking |

The second is the Cloudflare cron Worker in `workers/watchdog.ts`. It checks all
three endpoints every 2 minutes from outside the VPS - a watchdog living next to
the thing it watches dies with it, and its silence looks exactly like good news.
It pages after two consecutive misses (~4 min), repeats hourly while down, sends
one green ping a day as a dead-man's switch, and keeps per-day uptime counters
for soak testing. `GET /` returns the state; the same URL answers 503 when
production is down, so a single external check covers everything.

Alert channels are whichever secrets are set, and with none set it records state
but wakes nobody:

```bash
cd workers
wrangler secret put ALERT_WEBHOOK_URL  -c wrangler.watchdog.toml   # Discord/Slack
wrangler secret put TELEGRAM_BOT_TOKEN -c wrangler.watchdog.toml   # or Telegram
wrangler secret put TELEGRAM_CHAT_ID   -c wrangler.watchdog.toml
```

Once a channel is set, prove it delivers. An alert path nobody has ever seen
fire is not a monitor, it is a belief about a monitor:

```bash
wrangler secret put TEST_KEY -c wrangler.watchdog.toml
curl "https://flipthememe-watchdog.sofiaseremeteva.workers.dev/test-alert?key=<TEST_KEY>"
# -> {"sent":["telegram"],"channels":1}
```

The route 404s when `TEST_KEY` is unset, so it cannot be used to spam a phone.

`/health` is still the right probe for a container liveness check - it just must
not be the only thing watching the product.

- **Logs**: `docker compose logs -f --tail=200 backend keeper`.
- For longer-term log search, optionally pipe to [Axiom](https://axiom.co) free
  tier (500 GB/mo).

## 9. Operations cheat-sheet

| Action | Command |
|---|---|
| Tail logs | `docker compose logs -f backend keeper` |
| Restart everything | `docker compose restart` |
| psql into Postgres | `docker compose exec postgres psql -U flipthememe flipthememe` |
| Manual migration | runs automatically on boot via `runMigrations()` |
| **Emergency pause LP** | call `pause()` from your Ledger via Etherscan/Frame |
| **Emergency pause OrderbookMarket** | call `pause()` on each market from multisig |

## 10. Going through CDN

The public frontend is hosted on Vercel; the Cloudflare Worker (`workers/geo-block.ts`)
sits in front of `api.flipthememe.com` and rejects users from sanctioned juridictions.
The Worker must inject:

```
X-Country: US
X-Worker-Secret: <WORKER_SECRET from .env>
```

`/api/geo` rejects requests without this secret, so direct origin hits can't
spoof a country.
