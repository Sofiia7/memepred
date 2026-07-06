# MemePred — Marketing Playbook (соло-фаундер, бюджет ≤$2K)

Написан 2026-07-06. Роль: маркетинг-стратегия и готовые шаблоны «что, куда, когда постить».
Все шаблоны на английском (аудитория — Base/Farcaster crypto-natives), пояснения на русском.
Правило честности: **ничего не постить про то, что не работает** — сейчас продукт на Sepolia,
соак не пройден, мейннета нет. Шаблоны разбиты по фазам, чтобы это нельзя было перепутать.

---

## 1. Позиционирование — один месседж, везде одинаковый

**"Polymarket does BTC. We do memes."**

Полная версия (для био, лендинга, питчей):
> MemePred — 5-minute UP/DOWN prediction markets for memecoins on Base.
> PvP, non-custodial, USDC. Every Clanker launch becomes a market on day one.

Почему это работает:
- Polymarket уже приучил рынок к 5-минутным up/down рынкам (BTC/ETH/SOL) — нам не надо
  объяснять категорию, только отличие: **мемкоины, которых у них нет**.
- «Every Clanker launch becomes a market» — единственное, что не может скопировать
  Polymarket за неделю: это дистрибуция через Farcaster-культуру, а не фича.
- Из этого месседжа вытекает всё остальное: каналы (Farcaster-first), гранты (CEF),
  партнёрства (Clanker-токены сами заинтересованы в рынках на себя).

Чего НЕ говорить: «better than Polymarket» (нет ликвидности для такого сравнения),
«guaranteed yield» для LP (это риск-капитал), «trustless» без оговорок (keeper центральный).

---

## 2. Монетизация — что, когда включать

| Фаза | Источник | Действие |
|---|---|---|
| Сейчас → мейннет+3 мес | **Ничего. Осознанно.** | 0% fee — это маркетинговое оружие №1: «0% protocol fee for the first 3 months» в каждом лонч-посте. Понятный дедлайн создаёт urgency. |
| Мейннет+3 мес | **Протокольная fee 0.5%** | Уже в контракте (timelock 48ч, максимум 1%). Включение — это событие для поста, не тихая правка: «we're turning on fees as promised — here's the revenue dashboard». Прозрачность = контент. |
| С первого дня мейннета | **LP-пул (свой капитал)** | 1% taker fee с LP-побед + P&L пула. Это не «доход протокола», а доходность твоего собственного капитала — но она же и публичная метрика для привлечения чужих LP после заполнения Genesis. |
| Мейннет+1-2 мес | **Sponsored/Featured markets** | Токен-проекты платят за приоритетный спавн рынка своего токена + пин в UI + совместный каст. Цена входа: $200-500/нед. Это единственная B2B-строчка, которая не требует новых контрактов — только договорённость и пин на фронте. |
| Постоянно | **Гранты** | CEF (~$2.4K, заявка готова), Pyth Developer (PYTH-токены, драфт готов), Base Builder Grants (1-5 ETH ретроактивно, после мейннета). Гранты — это выручка нулевой фазы. |

Чего НЕ делать для монетизации: свой токен (убьёт грант-нарратив и добавит юр-рисков),
платная подписка (не для этой аудитории), увеличение fee выше 1% (контракт не даст — и хорошо).

---

## 3. Каналы: приоритет и роль

1. **Farcaster — главный и единственный обязательный канал.** Продукт — Farcaster mini-app;
   аудитория Base-мемов живёт там; CEF-стюарды читают там. 80% усилий сюда.
2. **X/Twitter — зеркало + охват.** Треды дублируют Farcaster-касты. KOL-бюджет один: $500
   на 1 mid-tier KOL в день мейннет-лонча (из ТЗ-чеклиста). Раньше лонча KOL не покупать —
   некуда конвертировать.
3. **Гранты — это тоже маркетинг.** Каждая заявка = знакомство со стюардами, которые сами
   ретвитят гранти. CEF-нота готова в `cef-application.md`, Pyth — в `pyth-grant-application.md`.
4. **Discord/Telegram — НЕ делать сейчас.** Соло-фаундеру нечем модерировать пустой сервер;
   мёртвый Discord вредит доверию сильнее, чем его отсутствие. Вернуться после 100+ DAU.

---

## 4. Календарь и шаблоны

### ФАЗА 0 — «Build in public» (сейчас, до мейннета; 2-4 недели)

Цель: 200-500 фолловеров на Farcaster + отправленные грант-заявки + 20 Genesis-вейтлист.
Ритм: **3 каста в неделю** (пн/ср/пт), 15-20 минут на каст. Не чаще — нечего сказать
ежедневно на этой фазе, а вымученный контент виден.

**Куда постить:** свой профиль + канал /base. Касты про Clanker-интеграцию — в /clanker.
Технические — в /dev или /founders. НЕ постить один текст в 3 канала разом (это спам,
за него мьютят) — один каст = один канал + свой профиль.

**Шаблон 0.1 — интро-каст (первый, закрепить в профиле):**
```
building memepred — 5-min UP/DOWN prediction markets for memecoins on base

polymarket does BTC. we do $PEPE, $BRETT, $TOSHI, $DEGEN — and every
/clanker token that gets a price feed, auto-listed on day one

PvP orderbook + LP vault fallback, USDC, pyth-settled, non-custodial
176 tests green, live on sepolia, mainnet after audit

first 20 LPs get a genesis NFT: 1.5x fee share, forever, tradeable

building in public here. testnet link in bio 🔵
```

**Шаблон 0.2 — еженедельный billboard-пост (каждый пн, менять цифры):**
```
memepred week [N] recap:

· [X] forge tests green ([+Y] this week)
· [конкретный фикс/фича недели — 1 строка человеческим языком]
· [что дальше — 1 строка]

still pre-mainnet. still 0% fee at launch. genesis LP waitlist: [ссылка/форма]
```

**Шаблон 0.3 — «how it works» серия (ср, 4 штуки по одной в неделю):**
```
how memepred settles a 5-minute market fairly (1/4):

naive approach: take pyth price at close. problem: one bad tick = wrong winner.

our approach: TWAP over the last ~60s of the market + auto-refund if
TWAP diverges >2% from spot (oracle glitch protection).

fair close > fast close. code is open: [repo link]
```
(2/4 — три слоя матчинга; 3/4 — LP vault и Genesis; 4/4 — почему non-custodial/где деньги лежат)

**Шаблон 0.4 — Genesis LP кампания (пт, повторять с прогрессом):**
```
20 genesis LP slots. [N] left.

what genesis LPs get:
· 1.5x share of LP fees — forever
· it's an NFT: sell the NFT, sell the boost
· first access to the vault before public

what LPs do: your USDC backs the "instant match" pool when no PvP
counterparty is online. you win when traders are wrong (and they're
wrong a lot on 5-min memecoin candles).

min 50 USDC. waitlist: [ссылка]
```

**CEF-заявка:** отправить ЭТУ неделю (нота готова в `cef-application.md`, блокеры:
подписать farcaster.json + VITE_API_URL — оба закрываются деплоем на VPS).
Куда: форма на gmfarcaster.com/cef ИЛИ каст в /CEF. После отправки — каст:
```
just applied for a /cef fresh clank grant 🤞

the pitch: every clanker token with a pyth feed becomes a prediction
market on memepred automatically — no listing process, the keeper
picks it up within minutes of launch

feedback welcome, especially from folks who've been through CEF before
```

### ФАЗА 1 — Мейннет-лонч (день D; только после аудита и соака)

**D-7 (за неделю), Farcaster + X:**
```
memepred mainnet: [дата]

· 5-min to 24h UP/DOWN markets on $PEPE $DOGE $BRETT $TOSHI $DEGEN +8 more
· 0% protocol fee for the first 3 months
· max bet capped at 100 USDC while we're young (safety > size)
· audited by [аудитор], report: [ссылка]

genesis LP vault opens same day. 20 NFT slots, [N] already claimed.
```

**D-0 лонч-каст (закрепить; X-версия — тред из 4-5 твитов по тем же пунктам):**
```
memepred is live on base mainnet 🔵

bet UP or DOWN on memecoins. 5 minutes to 24 hours. winners take the pot.

· USDC, non-custodial — funds live in the contract, not with us
· pyth-settled, TWAP close, auto-refund on oracle anomalies
· 0% fee for 3 months
· works as a farcaster mini-app — bet without leaving the feed

first market is live now: $PEPE 5-min. call it: [ссылка]
```

**D-0 KOL ($500, один mid-tier Base/degen аккаунт).** Бриф KOL'у (не давать писать отсебятину):
```
angle: "polymarket for memecoins, lives inside farcaster"
must mention: 5-min markets, USDC, non-custodial, 0% fee first 3 months
must NOT say: "guaranteed", "risk-free", "better than polymarket"
CTA: try one 5-min $PEPE market via the mini-app link
```

**D-0 + каждые 2-3 дня недели 1 — «receipts» касты:** скриншот реального сеттлмента:
```
first settled market on mainnet:

$PEPE 5-min · entry $0.0000XX · close $0.0000XX · UP wins
[N] traders · [X] USDC pot · settled by pyth TWAP, claimable instantly

next market's already open. [ссылка]
```

### ФАЗА 2 — Ритм роста (недели 2-8)

Ежедневный формат (5 мин работы, можно автоматизировать через бота позже):
```
today on memepred:
🥇 top caller: @[handle] — [N] correct in a row ([badge] badge earned)
📈 biggest pot: $[TOKEN] [duration] — [X] USDC
🔥 [юмор/наблюдение одной строкой про сегодняшний мем-рынок]
```

Еженедельно (пн) — метрики, публично и честно:
```
memepred week [N]:
· volume: $[X] ([+/-]% wow)
· unique traders: [N]
· LP vault: $[X] TVL, [X]% realized fee yield
· invariant monitor: 0 breaches (as always — that's the point)
```

Клэнкер-токен листится → в течение часа каст в /clanker:
```
$[TICKER] got a pyth feed → it's now tradeable on memepred

first market: 15-min UP/DOWN, opens now. is it going up, anon? [ссылка]
cc @[deployer токена]
```

---

## 5. Метрики успеха по фазам

- Фаза 0: 300+ фолловеров FC, CEF-заявка отправлена, 20/20 Genesis вейтлист, 50+ тестнет-кошельков
- Фаза 1 (мес 1): $50K+ объёма, 200+ уникальных трейдеров, LP vault $5K+ TVL чужих денег
- Фаза 2 (мес 3): $400K+/мес объёма (= точка, где 0.5% fee покрывает инфраструктуру), включение fee
- Каждый пост: сохранять скриншот метрик — это материал для Base Builder Grant (ретроактивного)

## 6. Бюджет (итого ≤$1.3K до мейннета+1 мес)

- $0 — весь Farcaster/X органический контент (время: ~3 ч/нед)
- $500 — 1 KOL-твит в D-0 (не раньше)
- $300-500 — seed-объём в первые рынки D-0 (чтобы не было пустых рынков на скриншотах)
- $200 — буст первого Genesis-каста через Warpcast-промо, если органика не дала 20 вейтлист за 2 нед
- Гранты покрывают: CEF ~$2.4K + Pyth (PYTH) + Base 1-5 ETH ретроактивно
