# Ротация секретов — runbook

> Создан после превентивного отзыва Pinata-ключа.
> **В этом файле НЕТ значений секретов** — только публичные адреса, имена переменных,
> пути к файлам и команды. Хранить в репо безопасно.

## TL;DR — оценка риска

- **Git чист.** За всю историю коммитился только `.env.example` (плейсхолдеры).
  Все реальные секреты лежат в **untracked** файлах (`.env`, `.env.*`, `deploy/.env`,
  `workers/.env`, `.testwallets/`, `*.json`) — они под `.gitignore` и в репозиторий не попадали.
- **Все ончейн-ключи — Base Sepolia (chainId 84532), тестнет.** Они защищают только
  тестовый ETH (доли цента) и тестовый USDC. Реальных денег на них нет.
- **Единственный секрет с реальной ценностью — Pinata** (внешний аккаунт). Уже отозван ✅.
- Вектор утечки — **НЕ git.** Если `.env` куда-то «засветился», то через: расшаренную/
  синхронизируемую папку (`C:\Server\memepred`), скриншот, вставку в чат, или проект на Vercel.
  → см. раздел D «Проверить остальные каналы».

**Вывод:** срочной угрозы нет. Это гигиена + правило «тестнет-ключи никогда не переезжают на mainnet».

---

## Полный инвентарь секретов

| Секрет | Где лежит | Тип | Утёк в git? | Действие |
|---|---|---|---|---|
| `PINATA_API_KEY` | `.env:42` | Внешний API | Нет | **Отозван.** Новый — только когда понадобится IPFS (см. A). В коде **не используется**. |
| `WORKER_SECRET` | `.env:66`, `deploy/.env:12`, `.testwallets/worker-secret.txt`, + Cloudflare secret воркера `memepred-edge` | HMAC-секрет geo-эндпоинта | Нет | **Ротировать** (см. C1) — он защищает живой `/api/geo`. |
| `POSTGRES_PASSWORD` | `.env:72` | Пароль БД | Нет | Ротировать, если backend публично доступен (C2). |
| `REDIS_PASSWORD` | `.env:73` | Пароль Redis | Нет | Ротировать, если Redis публично доступен (C2). |
| Deployer `PRIVATE_KEY` `0x3ae5218b…` → `0x12f9B9De…48BD2` | `.env:13`, `deploy/.env:11/25/26` | Ключ EOA (тестнет) | Нет | Burn-метка (B). Владелец всех контрактов. |
| Keeper `0x665aa9…` → `0xbFa008e5…eea4` | `.env:68`, `.testwallets/keeper.json` | Ключ EOA (тестнет) | Нет | Burn-метка (B). KEEPER_ROLE + marketCreator + emergencyPauser. |
| Badge minter `0xce39d2…` → `0xb183b09f…875e6` | `.env:17/77`, `.testwallets/badge-minter.json` | Ключ EOA (тестнет) | Нет | Burn-метка (B). |
| Multisig stand-in `0x0e2bd7…` → `0xAA1a14ad…9047F` | `.testwallets/multisig-standin.json` | Ключ EOA (тестнет) | Нет | На тестнете не используется. Burn-метка. |
| Бот-кошельки ×3 → `0x6E32…1895`, `0xfd43…dF48`, `0x5248…63F1` | `.testwallets/wallets.env` | Ключи EOA (тестнет) | Нет | Burn-метка. |
| Vercel OIDC token | `frontend/.vercel/.env.production.local:20` | Эфемерный JWT | Нет | **Ничего не делать** — Vercel сам ротирует (срок уже истёк). Файл не шарить. |
| `BASESCAN_API_KEY`, `DISCORD_BOT_TOKEN`, `TWITTER_BEARER_TOKEN` | `.env:21/43/44` | Внешние API | Нет | Сейчас плейсхолдеры (`...`), не заданы. |

> ⚠️ **Нашлось попутно (не безопасность, но почини):** deployer-ключ `0x3ae5218b…` в
> `deploy/.env` переиспользован как `KEEPER_PRIVATE_KEY` **и** `BADGE_MINTER_PRIVATE_KEY` —
> один ключ = деплойер+кипер+минтер. На mainnet это недопустимо (single point of failure).
> Плюс `deploy/.env` (docker-стек) и корневой `.env` указывают на **разные** keeper-ключи
> и разные адреса контрактов (`0x59385ca…` vs `0xFA747ac…`) — дрифт конфигов.

---

## A. Pinata — новый ключ

**Важно:** в коде Pinata нигде не вызывается (метадата NFT отдаётся через ончейн `tokenURI`/baseURI).
Новый ключ нужен только если будешь хостить JSON-метадату NFT на IPFS. Если нет — просто оставь поле пустым.

Когда понадобится:
1. https://app.pinata.cloud → **API Keys** → убедись, что старый ключ `c05393…` **удалён** (Revoke). Проверь, что других живых ключей нет.
2. **New Key** → сними галку «Admin», оставь только `pinFileToIPFS` + `pinJSONToIPFS` (минимальный scope).
3. Скопируй **JWT** (V3, не legacy api-key/secret).
4. Вставь в корневой `.env`:
   ```
   PINATA_API_KEY=<новый JWT>
   ```
   Когда появится код загрузки — слать как `Authorization: Bearer <JWT>`.
5. Больше нигде Pinata не дублируется — `deploy/.env`/`workers/.env` держат плейсхолдер `...`, его можно не трогать.

---

## B. Кошельки — что и как

Все ключи — **тестнет, расходный материал.** Рекомендация — **Track 1**.

### Track 1 — Минимальный (рекомендуется)
Не ротируем тестнет-кошельки (там пыль и нет реального риска). Вместо этого:
1. **Помечаем все 7 ключей как BURNED** — никогда не переносить на mainnet.
2. (Опц.) Вывести остатки тестового ETH на faucet-кошелёк — не обязательно (dust).
3. **На Sprint 7 (mainnet) генерим полностью новый набор ключей** + реальный Gnosis Safe.
   Это и есть настоящая «ротация» — свежие ключи под реальные деньги, отдельные роли:
   - deployer (one-shot), keeper (hot), badge-minter (hot) — **три разных** ключа;
   - владелец контрактов = Safe 3/5, не EOA.
   ```bash
   # сгенерировать новый ключ (Foundry ~/.foundry/bin)
   cast wallet new
   ```

### Track 2 — Полная ротация на тестнете (только если хочешь belt-and-suspenders)
Роли в контрактах привязаны к адресам, поэтому смена ключа = ончейн-операции от текущего owner
(`0x12f9B9De…48BD2`). Контракты (2-й деплой):
`MARKET_FACTORY=0xFA747ac4…`, `BADGE_NFT=0x25d87695…`, `LIQUIDITY_POOL=0x12bCb6D2…`, `ORACLE_RESOLVER=0x697BDC64…`.

1. `cast wallet new` ×3 → новые deployer/keeper/minter.
2. Сменить роли (от owner):
   - `MarketFactory.setMarketCreator(newKeeper)` + `setEmergencyPauser(newKeeper)`;
   - `grantRole(KEEPER_ROLE, newKeeper)` где есть + `revokeRole(KEEPER_ROLE, oldKeeper)`;
   - `BadgeNFT`: grant minter новому + revoke старому;
   - при необходимости `transferOwnership(newAdmin)` на всех 7 контрактах.
3. Профинансировать новые hot-кошельки тестовым ETH.
4. Обновить `.env`, `deploy/.env`, `.testwallets/*.json`, перезапустить keeper.

> Для тестнета Track 2 — это в основном busywork. Лучше потратить усилия на чистый mainnet-набор.

---

## C. Общие/инфра-секреты

### C1. `WORKER_SECRET` (ротировать — он живой)
Это shared HMAC между Cloudflare-воркером `memepred-edge` и backend (`x-worker-secret` header).
Лежит в **4 местах** — менять во всех одновременно:
```bash
# 1. сгенерировать новый (git bash)
openssl rand -hex 32
```
2. Обновить значение в: `.env` (стр. 66), `deploy/.env` (стр. 12), `.testwallets/worker-secret.txt`.
3. Залить в Cloudflare (из `workers/`):
   ```bash
   wrangler secret put WORKER_SECRET    # вставить то же значение
   ```
4. Перезапустить backend (docker-стек подхватит из env) — иначе geo-эндпоинт начнёт отбивать запросы воркера.

### C2. Пароли БД/Redis (если backend публично доступен)
```bash
openssl rand -hex 16   # для POSTGRES_PASSWORD
openssl rand -hex 16   # для REDIS_PASSWORD
```
1. Обновить `.env` (стр. 72–73).
2. `docker-compose down` → пересоздать том postgres (или `ALTER USER … PASSWORD`) → `up`.
   docker-compose тянет пароли из env (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL`, `REDIS_URL`).
3. Если БД крутится только на localhost — не срочно.

---

## D. Проверить остальные каналы утечки

- [ ] **Vercel** (dashboard → memepred-frontend → Settings → Environment Variables):
      у фронта секретов быть не должно — только публичные `VITE_*`. Если там оказался приватный
      ключ или `WORKER_SECRET` — удалить. Эфемерный OIDC-токен Vercel ротирует сам.
- [ ] **Cloudflare** (воркер `memepred-edge`): после C1 старый `WORKER_SECRET` больше не валиден.
- [ ] **Папка `C:\Server\memepred`**: не синхронизируется ли в облако (OneDrive/Dropbox/Google Drive)?
      Если да — `.testwallets/` и `.env` могли утечь туда. Исключить папку из синка.
- [ ] **История чата/скриншоты**: если `.env` куда-то вставлялся — считать все попавшие туда
      значения скомпрометированными и ротировать по этому runbook.
- [ ] **Бэкап-копии `.env.before-*`** (`.env.before-addresses`, `.env.before-dedup`,
      `.env.before-sepolia`): это снапшоты `.env` от прошлых сессий — держат **старые**
      секреты и ключи кошельков. После ротации в них смысла нет → удалить
      (`rm .env.before-*`). Они gitignored, в репо не попадали.
- [ ] **Pinata account**: 2FA включён? Других активных ключей нет?

---

## Чек-лист после ротации

- [ ] Pinata: старый ключ удалён; новый (если нужен) — только в `.env`.
- [ ] `WORKER_SECRET` обновлён в 4 местах + Cloudflare; backend перезапущен; `/api/geo` отвечает.
- [ ] DB/Redis пароли (если ротировал): стек поднимается, indexer/keeper коннектятся.
- [ ] Тестнет-ключи помечены BURNED; на mainnet поедет свежий набор (Sprint 7).
- [ ] Папка проекта не в облачной синхронизации.
- [ ] `git status` чист от секрет-файлов (должны быть только `.env.example` + этот runbook).
