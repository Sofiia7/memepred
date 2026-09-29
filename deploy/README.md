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
| `https://api.flipthememe.com/health/deep` | keeper out of gas, wedged nonce, watchdog snapshot stale (5 min), USDC invariant drift, or the oldest match more than an hour past its settleAt |
| `https://flipthememe-watchdog.sofiaseremeteva.workers.dev/` | any of the above, **or** the API or frontend is down, **or** the watchdog itself stopped ticking |

The second is the Cloudflare cron Worker in `workers/watchdog.ts`. It checks all
three endpoints every 2 minutes from outside the VPS - a watchdog living next to
the thing it watches dies with it, and its silence looks exactly like good news.
It pages after two consecutive misses (~4 min), repeats hourly while down, sends
one green ping a day as a dead-man's switch, and keeps per-day uptime counters
for soak testing. `GET /` returns the state; the same URL answers 503 when
production is down, so a single external check covers everything.

It checks every 2 minutes but persists state at most every 10, because Workers
KV's free tier is four budgets and the binding one is writes: 100,000 reads a
day against 1,000 writes. A put per tick was 720 writes/day - 72% of the cap for
one small key - and produced a "50% of your KV limit" e-mail on 2026-08-29 with
reads at 0.6%. Failures, recoveries, alerts and day boundaries still persist
immediately; only quiet green ticks are batched, so detection is unchanged and
a bad day costs ~144 writes instead of 720.

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

## 11. Robinhood Chain testnet stack (rhc-backend, rhc-keeper)

Two extra services in the SAME compose project as Base (`docker-compose.rhc.yml`), sharing its Postgres
and Redis: their own database `memepred_rhc` and Redis database 1. Naming only these two services in
every command keeps Base's containers exactly as they are.

**Where it lives on the VPS.** The compose project directory is `/home/openclaw/memepred/deploy`. The
image is built from a separate, minimal source tree at `/home/openclaw/memepred-rhc` (not a git
checkout): the workspace manifests (root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`frontend/package.json`, `workers/package.json`), `backend/` (src, scripts, package.json,
tsconfig.json) and `deploy/backend.Dockerfile`. `.env.rhc` sits next to it. pnpm reconciles
`--frozen-lockfile` against EVERY workspace manifest, so all of them have to be in sync, not just
`backend/`.

**Syncing the tree** (from the repo root, on a machine that has the repo):

```bash
tar czf rhc-src.tgz pnpm-workspace.yaml package.json pnpm-lock.yaml frontend/package.json \
  workers/package.json backend/package.json backend/tsconfig.json backend/src backend/scripts \
  deploy/backend.Dockerfile
# copy it over, then on the VPS:
cd /home/openclaw/memepred-rhc && mv backend/src backend/src.bak-$(date +%Y%m%d%H%M) \
  && tar xzf /tmp/rhc-src.tgz
```

**Build and start** (on the VPS):

```bash
cd /home/openclaw/memepred/deploy
docker compose -f docker-compose.yml -f docker-compose.rhc.yml build rhc-backend rhc-keeper
docker compose -f docker-compose.yml -f docker-compose.rhc.yml up -d rhc-backend rhc-keeper
```

Migrations run by themselves when either container starts (`runMigrations()`, under an advisory lock).

**After a contract redeploy.** Put the new addresses and `INDEXER_START_BLOCK` (a block just before the
deployment) into `.env.rhc`, then clear the indexer cursors so the new deployment's first events are not
skipped, then restart:

```bash
docker exec deploy-postgres-1 psql -U memepred -d memepred_rhc -c "DELETE FROM _indexer_cursor"
docker compose -f docker-compose.yml -f docker-compose.rhc.yml up -d --force-recreate rhc-backend rhc-keeper
```

Markets, orders and matches of the previous deployment stay in the database. From migration 008 every
market row carries the factory that created it and the API and keeper only serve and act on the current
factory's markets, so nothing has to be deleted.

**Environment (`.env.rhc`, all read through `env_file`).**

| Variable | Meaning |
|---|---|
| `CHAIN_PROFILE=rhc`, `CHAIN_ID=46630`, `RHC_RPC_URL` | chain profile and RPC |
| `MARKET_FACTORY`, `ORACLE_RESOLVER`, `FEE_DISTRIBUTOR`, `REFERRAL_REGISTRY`, `GENESIS_NFT`, `LIQUIDITY_POOL`, `BADGE_NFT`, `USDC_ADDRESS` | the deployment (`USDC_ADDRESS` is the stake token, WETH, named that way because `config.ts` reads it) |
| `INDEXER_START_BLOCK` | first block the indexer scans when it has no cursor |
| `KEEPER_PRIVATE_KEY`, `KEEPER_ADDRESS` | the settlement wallet, needs testnet ETH (see `/health/deep`) |
| `WORKER_SECRET` | must equal the secret of the Cloudflare Worker `flipthememe-edge-rhc`; without it the origin accepts direct requests and every visitor shares one rate-limit bucket |
| `ALLOWED_ORIGINS` | CORS origins of the RHC site, for example `https://rhc.flipthememe.com` (the built-in default is the Base site only) |
| `RHC_AUTO_CREATE_MARKETS=false` | markets are created by hand after review |
| `READY_MATCH_WARN_SEC` | `/health/deep` warns when a due match has waited longer than this (default 90) |
| `GIT_COMMIT` | shown by `GET /api/deployment` so a reviewer can tie the running code to a commit |

**Making it public.** Three things have to exist together: a proxied DNS record `api-rhc` in the
`flipthememe.com` zone, the Caddy site block for `api-rhc.flipthememe.com` (reverse proxy to
`rhc-backend:3002`), and the Worker `flipthememe-edge-rhc` with the same `WORKER_SECRET`. Check with
`curl https://api-rhc.flipthememe.com/health`, `/health/deep`, `/health/edge` and `/api/deployment`.

**Caddyfile warning.** The live Caddyfile on the VPS also serves a site that belongs to another project.
This repo's `deploy/Caddyfile` does NOT contain it, so never copy the repo file over the live one; edit the
live file in place, run `caddy validate` and only then reload.
