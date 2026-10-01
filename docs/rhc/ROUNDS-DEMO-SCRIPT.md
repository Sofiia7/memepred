# Видео для HackQuest: сценарий и закадровый текст

Дополняет [`ROUNDS-DEMO-RUNBOOK.md`](ROUNDS-DEMO-RUNBOOK.md): там подготовка и подтверждённые транзакции, здесь покадровый
план и текст. Длина 3:30–3:50 при обычном темпе речи. Закадровый текст на английском, он и записывается; ремарки на
русском, они для записи.

## Подготовка за день

1. Два кошелька с тестовым ETH: A на камере, B за кадром (второй браузер или профиль). B ставит противоположную сторону
   той же суммой, чтобы раунд активировался (банк от 0.02 WETH, значит минимум по 0.01 с каждой стороны).
2. Сайт после выкладки гео-переключателя (runbook, «Перед записью», п. 1) и публичный `/rounds` с тремя пулами.
3. Цена стенд-ин пула должна двигаться между страйком и выходом, иначе будет ничья. Запустить мувер на пул, который
   показываешь (MOONCAT для раундов: `0x56bddc1c5a201273c99fa0925e35b46c4f3cff99`), за пять минут до закрытия ставок и
   выключить после расчёта:

   ```
   set RHC_MOVER_POOLS=0x56bddc1c5a201273c99fa0925e35b46c4f3cff99
   set RHC_MOVER_EVERY=60
   set RHC_MOVER_MAX_TX=20
   scripts\node_modules\.bin\tsx scripts\rhc\price-mover.mts
   ```

   Каждый толчок навсегда дорожает `observe()` этого пула примерно на 8 тысяч газа (`ECONOMICS.md`, «Найденный дефект»),
   поэтому 20 толчков, не больше. Направление случайное: в тексте ниже исход назван как «моя сторона выиграла»; если
   выиграла другая, прочитать вариант в скобках, он написан.
4. Раунды привязаны к часам цепочки: пятиминутный раунд открывается на границе кратной 5 минутам. Начать запись за
   минуту до открытия, чтобы успеть показать экран, поставить A и B и дождаться `closeAt`.
5. Запись идёт двумя кусками: до закрытия ставок и от результата. Между ними 15 минут реального ожидания, в монтаже
   показать таймлайн экрана и подпись «15 minutes later». Не склеивать так, будто результат пришёл сразу.
6. Открыть заранее вкладки: `/rounds`, обозреватель с верифицированным контрактом
   (`explorer.testnet.chain.robinhood.com/address/0xe3620f0855c4dc1aace648cc8240a4fa89fd93c4`),
   `api-rhc.flipthememe.com/api/rounds/health`, `docs/rhc/measurements/rounds/mainnet-fork-2026-10-01.md` в репозитории.
7. Запасной вариант, если живой раунд не сложился: показать подтверждённые транзакции из runbook (ставка, встречная
   ставка, выигрыш 0.0392, ничья 0.0099) и прочитать блок 4 с оговоркой «this round was settled by the keeper on
   30 September».

## Покадровый план

| Время | На экране | Текст |
|---|---|---|
| 0:00–0:20 | `/rounds` без кошелька: шапка «Robinhood Chain testnet», три пула | блок 1 |
| 0:20–1:15 | Карточка пула: глубина и потолок банка; раскрыть раунд: UP/DOWN so far, таймлайн; курсор по строкам таймлайна | блок 2 |
| 1:15–2:15 | Connect, баланс ETH/WETH, кнопка WRAP, выбор стороны, сумма 0.01, блок оценки, правила, чекбокс, две подписи | блок 3 |
| 2:15–2:25 | Ставка B с другого кошелька за кадром; экран A показывает обе суммы и «you are in»; `closeAt` | блок 4, первые фразы |
| 2:25–2:35 | Подпись «15 minutes later», таймлайн с пройденными фазами | блок 4 |
| 2:35–3:10 | «Your bets»: результат, Collect, транзакция в обозревателе, страница контракта с `is_verified`, `/api/rounds/health` | блок 4 |
| 3:10–3:50 | README: схема, таблица «Evidence and limits», файл fork-проверки с числами | блок 5 |

## Закадровый текст

### 1. Проблема (0:00–0:20)

If you like betting on outcomes, you know the feeling. There is a meme coin on Robinhood Chain you follow, you have a
view on the next twenty minutes, and there is no market for it. FlipTheMeme gives you a short UP or DOWN round on that
coin, without buying it. This is a testnet prototype: the stake is test WETH, and the three pools you will see are
stand-ins with scripted prices.

### 2. Экран (0:20–1:15)

This is the Rounds tab. Each pool shows its depth and the largest matched bank a round can take. The contract reads
that from the pool itself; a pool that cannot prove its depth and price history cannot be listed.

Every five-minute round is in the open: how much is on UP, how much on DOWN. Only matched stakes play. Whatever the
bigger side has over the smaller side comes back without a fee.

The timeline is the part that matters. Bets close, then nothing is priced for five minutes. Then the strike is averaged
over five minutes from the pool's own observations, and the exit is read five minutes after that. You are betting on
the move from that future strike to the exit, not on the price you see now. The result is due about twenty minutes
after the round opened.

### 3. Ставка (1:15–2:15)

I connect a wallet on the Robinhood Chain testnet. It holds test ETH from the faucet, and the form wraps exactly what
it needs into test WETH.

I pick DOWN and stake 0.01 WETH. The form shows what would play at the current sums, what I would collect if my side
wins, 0.0196 WETH, which is 1.96 times the accepted stake, and the fees: two percent of the matched bank when there is
a winner, one percent on a tie or a refund. Before signing I confirm that I understand the strike is in the future.
One approval for exactly this stake, then the bet. Two wallet prompts.

### 4. Результат (2:15–3:10)

Another wallet took UP for the same amount, so the round activated with a matched bank of 0.02 WETH. Bets are closed.

I am cutting the wait here; the timeline on screen shows where we are.

After the strike window the keeper fixed the strike, and after the exit it settled the round. Both calls are public:
anyone can make them, and if nobody does within 24 hours, the round refunds. Here is the result in my list: DOWN won.
(Если выиграл UP: *Here is the result in my list: UP won, so my stake went to the other side. That is the whole
game.*) And here is Collect. Payouts are never pushed to you; you collect them. The transactions are on the testnet
explorer, the contract is source-verified there, and the keeper publishes its health, including the deadlines it has
to meet.

### 5. Почему так, доказательства, границы (3:10–3:50)

Why these rules. Only matched stakes play, so every payout is funded by the two sides. There is no house and no
liquidity vault. The future strike gives both sides the same price window after betting closes. The pool's depth
limits the round, and a thin pool cannot be listed at all.

We checked the same contract against a real pool. On a local fork of Robinhood Chain mainnet it listed the canonical
RMHT/WETH pool, read its real price history, and paid a tie. After a swap made inside the fork, it settled UP and paid
the winner. That swap was a simulation, not a mainnet trade.

What this is not. Not audited. Not on mainnet. The demo pools do not show real demand. The depth rule limits what
pushing a pool's price can win; it does not remove it. The next step is one coin community playing real rounds on
these rules, and we will say what we learned.

## После записи

- Открыть видео в браузере без логина; проверить, что ссылки из описания открываются так же.
- В описание видео: ссылка на `/rounds`, на верифицированный контракт и на репозиторий после открытия.
- Если показывался запасной вариант (п. 7), в описании сказать, что показанный раунд рассчитан кипером 30 сентября.
