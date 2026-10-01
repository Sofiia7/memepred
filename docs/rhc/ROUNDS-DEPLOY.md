# Развёртывание раундов PoolRounds на тестнет Robinhood Chain (46630)

Этот документ начинался 2026-09-30 как **подготовительный план**. Формулировки ниже о том, что ничего не было
отправлено, относятся к первоначальной репетиции. Позже 30.09 контракт, стенд-ин пулы, кипер и сайт были
развёрнуты на Robinhood Chain testnet; актуальные адреса и сквозной прогон — в [`DEPLOYMENTS.md`](DEPLOYMENTS.md),
результат на настоящем пуле mainnet через локальный fork — в
[`measurements/rounds/mainnet-fork-2026-10-01.md`](measurements/rounds/mainnet-fork-2026-10-01.md).

Контракт: `contracts/src/PoolRounds.sol` в рабочей копии, с правками повторного аудита (`depthPerBank`, глубина окна из
`secondsPerLiquidity`, `CARDINALITY_SLACK` 600, `keeperDeadlines`). **Он менялся во время этой работы** (sha256
`27a64e16...` в 03:54, `e319a154...` и `19a6f97e...` в 04:08-04:09, `690669f5...` в 04:14 по часам машины); прогоны в
`e2e-local.log` и последнее чтение тестнета сняты на `690669f5...`. `ROUNDS-CONTRACT.md` и `ROUNDS-KEEPER.md` пока описывают прежнюю версию (кольцо 420, сроки 119 и
359 с); здесь числа текущие, скрипты читают их из контракта. Решение о v2 и повторный аудит - за Софией (решение 24).

Все команды для Софии - в обычном **cmd.exe** (Win+R, `cmd`). Команды для Claude помечены отдельно.

## Выводы за минуту

1. **Демо-пулы MOONCAT, PEPE и FROGGO раундам не подходят.** Гейт листинга их не пускает (глубина 40 WETH при гейте
   50, кольцо 300 при 900), а если их «дорастить», они проходят листинг, но каждый активированный раунд уходит в
   REFUND с комиссией 1%: этот мок не отдаёт `secondsPerLiquidity`, контракт видит глубину окна 0. Поэтому первым
   шагом ставятся **новые стенд-ин пулы `PoolRoundMockPool`** в своей стенд-ин фабрике (шаг 2), на тех же демо-токенах,
   чтобы на сайте были знакомые имена. Демо от 29.09 это не трогает.
2. **Весь путь отрепетирован локально:** отказ скрипта на пуле как на тестнете (ничего не отправлено), новые
   стенд-ины, развёртывание настоящим скриптом, связка реестра, кипер из `backend/src/rounds` (импортом), выигрыш 1.96x,
   ничья, раунд без второй стороны, REFUND на старом моке, реферал, вывод комиссий: 73 проверки, 0 упавших, дважды
   (`measurements/rounds/e2e-local.log`).
3. **Стоимость при 0.01 gwei:** стенд-ины и развёртывание вместе около 11-13 млн газа, **0.00011-0.00013 ETH**; у
   деплойера 0.005834 ETH, хватает с запасом в 40 раз (до цены газа около 0.4 gwei). Кипер: около 0.2 млн газа на
   активированный раунд на свежем пуле плюс 14.4 тыс. за каждую записанную ступень цены.
4. **Что решить владельцу** - в конце: запуск v2 вообще, коммит контракта до деплоя, где работает кипер, выкладывать
   ли вкладку раундов на публичный сайт, чем двигать цену новых пулов.

## Что нужно заранее

**Решения.** Запуск v2 на тестнете (контракт не прошёл повторный аудит в текущей редакции). И **закоммитить
контракт до развёртывания**: forge записывает в `broadcast` коммит HEAD, исходники верифицируются из этого коммита
(`DEPLOYMENTS.md`), а сейчас `PoolRounds.sol` и `DeployPoolRounds.s.sol` не закоммичены. `rounds-deploy.mts deploy`
на тестнете откажется работать с незакоммиченным кодом (обойти можно флагом `--allow-uncommitted`, тогда состояние
дерева надо записать в `DEPLOYMENTS.md` руками).

**Переменные в `C:\Server\memepred\.env`** (все уже есть, ими разворачивался стек 29.09; значения скрипты не печатают):

| Имя | Что |
|---|---|
| `PRIVATE_KEY` | ключ деплойера `0x12f9...8BD2`; он же станет владельцем `PoolRounds` |
| `MULTISIG_ADDRESS` | заглушка мультисига; должна отличаться от деплойера (иначе скрипт откажет) |
| `TREASURY_ADDRESS` | куда `withdrawFees` отправляет долю проекта |
| `KEEPER_ADDRESS` | станет `pauser` (может поставить паузу новым ставкам, снять - только владелец) |
| `RHC_WETH_ADDRESS`, `RHC_V3_FACTORY_ADDRESS` | стенд-ины WETH и фабрики демо |

Новые, появятся по ходу (шаг 2 и 4): `ROUNDS_V3_FACTORY_ADDRESS`, `ROUNDS_POOLS`, `ROUNDS_ADDRESS`,
`ROUNDS_START_BLOCK`. Их можно не писать в `.env`, а задавать `set ИМЯ=значение` в том же окне cmd.

**Кошельки и балансы** (сверено 30.09, `testnet-gate.md`):

| Кошелёк | Сейчас | Нужно |
|---|---:|---|
| деплойер `0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2` | 0.005834 ETH | 0.00013 на шаги 2-5 при 0.01 gwei; с запасом на всплеск цены - от 0.002 |
| кипер `0xbFa008e5A8d46d2014b83551ce6209108416eea4` | 0.010932 ETH | общий со старыми рынками; раздел «Стоимость» |
| кошельки soak (`scripts\rhc\.soak-wallets.json`, первые три) | не сверялись | по 0.0002 ETH у двух игроков и 0.00005 у реферера для сквозной проверки; `rounds-e2e.mts --testnet` печатает их балансы |

**Что должно быть остановлено на время шагов 2-8:** `scripts\rhc\soak-traders.mts` и `scripts\rhc\price-mover.mts`
(они шлют с тех же кошельков, а деплойер у soak пополняет кошельки: одновременные отправки с одного адреса
сталкиваются на nonce).

**Инструменты:** forge в `%USERPROFILE%\.foundry\bin` (в PATH не нужен), Node и `scripts\node_modules` (уже
установлены), собранный `contracts\out` (`forge build` из папки `contracts`).

## Шаг 0. Сборка

```
cd /d C:\Server\memepred\contracts
%USERPROFILE%\.foundry\bin\forge.exe build
%USERPROFILE%\.foundry\bin\forge.exe test --match-path "test/PoolRound*"
cd /d C:\Server\memepred
```

## Шаг 1. Проверить сеть и гейт, ничего не отправляя

```
scripts\node_modules\.bin\tsx scripts\rhc\rounds-gate-check.mts
scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts plan
```

Первая команда повторяет замер `testnet-gate.md` (только чтение публичного RPC). Вторая читает `.env`, печатает
адрес деплойера, его баланс, цену газа, гейт (глубина от 50 WETH, кольцо от 900) и что делать дальше. Если в
`ROUNDS_POOLS` уже что-то задано, проверяет каждый пул: пара с WETH, канонический в фабрике, глубина, кольцо,
история 300 с, отдаёт ли пул `secondsPerLiquidity`.

## Шаг 2. Стенд-ин пулы для раундов

```
scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts standins --yes-testnet
```

Разворачивает новую стенд-ин фабрику (`MockUniswapV3Factory`, только для раундов: старый кипер следит за фабрикой
демо и не станет создавать на новых пулах рынки `PoolMarketFactory`) и три `PoolRoundMockPool` 1% на демо-токенах
MOONCAT, PEPE, FROGGO и стенд-ин WETH: регистрация в новой фабрике, два часа истории на тике 0, история ликвидности
(`setLiquidity` пишет её с момента вызова: из неё `fixStrike` и `settle` берут глубину окна), кольцо `minCardinality`
(900) и глубина `max(1 000, 20 x gateDepth)` WETH. Гейт `gateDepth = max(2, depthPerBank x minBank) = 2500 x 0.02 = 50`
WETH, банк раунда не больше `maxBankOf = глубина / depthPerBank`, то есть с глубиной 1 000 до 0.4 WETH. 16 транзакций
от деплойера (19 с новыми токенами).
Настройки: `ROUNDS_STANDIN_DEPTH_ETH` (глубина в WETH; ниже гейта шаг откажет), `ROUNDS_STANDIN_TOKENS` (свои токены
через запятую или `new` для новых `MockToken`).

**Откуда числа.** Скрипты не держат гейт и сроки константами. `plan`, `standins` и зонд проверки гейта берут
`depthPerBank`, `minBank`, окно страйка из переменных или из значений по умолчанию самого `DeployPoolRounds.s.sol`
(читают его исходник), а `MIN_POOL_WETH_DEPTH`, `CARDINALITY_SLACK` и предел окна выхода - из исходников
`PoolRounds.sol` и `PoolRoundOracle.sol`. После развёртывания `rounds-e2e.mts` и кипер читают у самого контракта
`depthPerBank`, `gateDepth`, `maxBankOf`, `minCardinality` и `keeperDeadlines(roundId)`. Если контракт поменяют ещё раз,
числа в этом документе устареют, а скрипты - нет.

В конце печатает две строки. Выполнить их в том же окне (или вписать в `.env` без `set `):

```
set ROUNDS_V3_FACTORY_ADDRESS=0x...
set ROUNDS_POOLS=0x...,0x...,0x...
```

И проверить: `rounds-deploy.mts plan` должен показать все три пула `OK`.

## Шаг 3. Пробный прогон скрипта развёртывания

```
scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts simulate
```

Это `forge script script/DeployPoolRounds.s.sol` **без** `--broadcast`: forge исполняет всё на своей копии состояния
тестнета и печатает адреса, которые получились бы, и оценку газа. Ничего не отправляется. Если пул не проходит гейт,
здесь будет `PoolTooThin`, `CardinalityTooLow` или `PoolCannotServeWindow`.

## Шаг 4. Развёртывание

```
scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts deploy --yes-testnet
```

`forge script ... --broadcast --slow` только против `https://rpc.testnet.chain.robinhood.com` (другую цепочку скрипт не
примет, 4663 отвергает явно). Порядок, как в скрипте: новый `ReferralRegistry`, `PoolRounds` (кап 1, пауза 300, окно
страйка 300, `depthPerBank` 2500, ставка 0.005-0.04, `minBank` 0.02, `costAllowance` 69 692 gwei), связка реестра
`setMarketFactory(PoolRounds)` и `authorizeMarket(PoolRounds)`, длительность 300 с, `listPool` для каждого пула из
`ROUNDS_POOLS`, `setPauser(KEEPER_ADDRESS)`. Права мультисигу на тестнете не передаются (`RHC_HANDOVER` не задан).
9 транзакций.

В конце печатает (то же в любой момент позже: `rounds-deploy.mts after`):

- `POOL_ROUNDS` и адрес реестра, первый блок развёртывания, газ и ETH по квитанциям, коммит;
- строки для кипера: `ROUNDS_ENABLED=true`, `ROUNDS_ADDRESS=...`, `ROUNDS_START_BLOCK=...`;
- строки для сборки сайта: `VITE_ROUNDS_ENABLED=1`, `VITE_POOL_ROUNDS_ADDRESS`, `VITE_ROUNDS_DEPLOY_BLOCK`,
  `VITE_ROUNDS_DURATIONS=300`;
- готовые команды верификации (шаг 5) с аргументами конструктора из самой транзакции;
- готовый раздел для `DEPLOYMENTS.md` (шаг 9).

Запись forge о развёртывании: `contracts\broadcast\DeployPoolRounds.s.sol\46630\run-latest.json`. Если скрипт упал
посередине, сначала посмотреть туда (что уже отправлено), а не запускать заново.

## Шаг 5. Верификация исходников на обозревателе

Команды печатает шаг 4; их вид:

```
cd /d C:\Server\memepred\contracts
set BASESCAN_API_KEY=unused
%USERPROFILE%\.foundry\bin\forge.exe verify-contract <POOL_ROUNDS> src/PoolRounds.sol:PoolRounds --chain-id 46630 --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/ --constructor-args <из вывода шага 4> --watch
%USERPROFILE%\.foundry\bin\forge.exe verify-contract <РЕЕСТР> src/ReferralRegistry.sol:ReferralRegistry --chain-id 46630 --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/ --watch
```

`BASESCAN_API_KEY=unused` нужен только потому, что `foundry.toml` ссылается на эту переменную. Верифицировать из того
коммита, из которого развёрнуто. `Fail - Unable to verify` на верный исходник обозреватель уже давал: сначала
повторить.

**`ReferralRegistry` скорее всего получит «already verified»:** его байткод совпадает с уже верифицированными
реестрами, forge пропускает его, а флаг `is_verified` остаётся `false` (так было 29.09). Тогда отправить напрямую в API
обозревателя (поля формы - как это прошло 29.09 по записи в памяти; если API ответит ошибкой поля, сверить с формой
Verify & Publish на обозревателе):

```
cd /d C:\Server\memepred\contracts
%USERPROFILE%\.foundry\bin\forge.exe verify-contract <РЕЕСТР> src/ReferralRegistry.sol:ReferralRegistry --chain-id 46630 --show-standard-json-input > %TEMP%\registry-input.json
curl.exe -X POST "https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/<РЕЕСТР>/verification/via/standard-input" -F "compiler_version=v0.8.24+commit.e11b9ed9" -F "license_type=mit" -F "autodetect_constructor_args=true" -F "files[0]=@%TEMP%\registry-input.json;type=application/json"
```

Проверка, для каждого адреса (`"is_verified": true`):

```
curl.exe -s https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/<АДРЕС>
```

Стенд-ин пулы и фабрику шага 2 верифицировать не обязательно (их исходники в `contracts/test`); `PoolRoundMockPool`
новый, его можно так же: `test/PoolRoundMockPool.sol:PoolRoundMockPool`, аргументы конструктора - токены и 10000.

## Шаг 6. Кипер раундов

Кипер обязан успевать: `fixStrike` не позже `keeperDeadlines(roundId).fixStrikeBy` (в текущей версии `strikeEnd + 599`
с), `settle` не позже `settleBy` (`settleAt + 839` с при раунде 300 с, `settleAt + 719` при 900 с: запас равен
`minCardinality - 1 - окно выхода`). Опоздание на настоящем оживлённом пуле делает
раунд REFUND с комиссией 1% для всех. На стенд-ин пулах история не теряется никогда, поэтому на тестнете опоздание
само по себе ничего не сломает и **его не увидеть**: смотреть на задержку в логах и в сквозной проверке (шаг 7).
Неактивированные раунды кипер не оплачивает.

Три переменные включают модуль раундов (`backend/src/rounds`, `ROUNDS-KEEPER.md`):

```
ROUNDS_ENABLED=true
ROUNDS_ADDRESS=<POOL_ROUNDS из шага 4>
ROUNDS_START_BLOCK=<первый блок из шага 4>
```

Где ему работать - решение владельца. Два варианта, оба с тем же кодом.

### Вариант A. На машине Софии, отдельным скриптом, без Postgres и Redis

```
cd /d C:\Server\memepred
set ROUNDS_ADDRESS=0x...
set ROUNDS_START_BLOCK=...
scripts\node_modules\.bin\tsx scripts\rhc\rounds-keeper-local.mts
```

`scripts/rhc/rounds-keeper-local.mts` импортирует настоящий код кипера (`backend/src/rounds`, общий
`keeperWallet.sendKeeperTx`), заменяет только Redis файлом `scripts\rhc\.rounds-keeper-<адрес>.json` (в git не
попадает), чтобы после перезапуска помнить, сколько раунд уже стоил. Тик раз в 5 с, строка в окне при каждой
транзакции и раз в 10 минут. `--once` - один тик и выход.

Кошелёк - по умолчанию деплойер (`PRIVATE_KEY`), другой - `--key-env ИМЯ_ПЕРЕМЕННОЙ`. `KEEPER_PRIVATE_KEY` скрипт не
примет: из него шлёт кипер на сервере, два процесса на одном кошельке сталкиваются на nonce. fixStrike и settle
открыты всем, поэтому особый кошелёк не нужен.

Ограничения: работает, пока открыто окно cmd и машина не спит; после перезагрузки его никто не запустит. `/health/deep`
и сторож его не видят.

### Вариант B. Контейнер `rhc-keeper` на VPS

**Это делает Claude, по отдельному явному разрешению Софии, не в этой работе.** Код раундов на сервере ещё не лежит:
`backend/src/rounds/` и правки `backend/src/index.ts`, `backend/src/keeper/index.ts`, `backend/src/routes/keeperHealth.ts`
есть только в рабочей копии. Доступ - только через `bash /c/Server/twitter_hermes/tools/vps.sh`, один заход за раз,
`VPS_TRIES` не выше 2, перед заходом проверить, не держит ли соединения `ChatGPT.exe` (общие правила). Два захода:

1. локально собрать архив по рецепту 29.09 (`pnpm-*`, `package.json` всех воркспейсов,
   `backend/{src,scripts,package.json,tsconfig.json,vitest.config.ts}`, `deploy/backend.Dockerfile`), затем **один**
   `vps.sh push <архив> /home/openclaw/tmp` со скриптом: копия текущего `/home/openclaw/memepred-rhc` в
   `/home/openclaw/backups`, распаковка в `/home/openclaw/memepred-rhc`, три строки в `/home/openclaw/memepred-rhc/.env.rhc`
   (дописать, если их нет: `grep -q '^ROUNDS_ENABLED=' .env.rhc || echo 'ROUNDS_ENABLED=true' >> .env.rhc`, так же
   адрес и блок), сборка в фоне `nohup docker compose -f docker-compose.yml -f docker-compose.rhc.yml build rhc-backend rhc-keeper`
   из `/home/openclaw/memepred/deploy`;
2. не раньше чем через несколько минут **второй** заход `vps.sh run`: `docker compose ... up -d rhc-backend rhc-keeper`,
   затем в том же заходе `docker logs --since 5m deploy-rhc-keeper-1 | grep '\[rounds\]'` (ждём строку
   `PoolRounds keeper on <адрес>`) и `/api/rounds/health` изнутри (секрет брать `docker exec ... printenv` в
   переменную, не печатать).

Кипер на сервере шлёт от `KEEPER_PRIVATE_KEY` (тот же кошелёк, что у старых рынков, один процесс, общий менеджер
nonce). Кошелёк общий со старыми рынками: см. «Стоимость». Одновременно варианты A и B не запускать с одним
кошельком; с разными можно, контракт отвергнет второй вызов (`StrikeAlreadyFixed`, `AlreadySettled`) после пробного
вызова, бесплатно.

## Шаг 7. Сквозная проверка на тестнете

```
cd /d C:\Server\memepred
set ROUNDS_ADDRESS=0x...
set ROUNDS_START_BLOCK=...
scripts\node_modules\.bin\tsx scripts\rhc\rounds-e2e.mts --testnet
```

Без `--yes-testnet` только читает: цепочка 46630 (иначе отказ), что по адресу `PoolRounds`, WETH и казна, цена газа,
адреса и балансы игроков (первые три ключа `.soak-wallets.json`; ключи не печатаются), какие пулы (три первых
`PoolListed` от блока развёртывания или `ROUNDS_E2E_POOLS=win,tie,one`) и план. Потом:

```
scripts\node_modules\.bin\tsx scripts\rhc\rounds-e2e.mts --testnet --yes-testnet --log docs\rhc\measurements\rounds\e2e-testnet.log
```

Около 25 минут: ставки в следующем окне 300 с (A по 0.02 с каждой стороны, TIE по 0.01, ONE 0.01 с одной стороны),
возврат ONE в `closeAt`, ожидание страйка, **одна** ступень цены на пуле A (каждая ступень стенд-ина навсегда дорожает
чтения, решение 21), ожидание расчёта, четыре `claim`, `claimReferral`, `withdrawFees`. Проверки те же, что на anvil,
плюс задержка кипера против `keeperDeadlines`. Кипер по умолчанию внешний (шаг 6 должен работать); `--keeper inline`
запускает код кипера внутри скрипта (кошелёк `--keeper-key-env`, по умолчанию `PRIVATE_KEY`), если отдельного кипера
нет. Стоимость прогона - около 1.6 млн газа игроков и 0.4 млн кипера, 0.00002 ETH при 0.01 gwei.

## Шаг 8. Сайт с вкладкой раундов (выполнено 30.09)

Экран выключен, пока сборка не задаёт `VITE_ROUNDS_ENABLED=1` (`ROUNDS-UI.md`). Выкладка **меняет публичное демо**
`rhc.flipthememe.com`: вкладка ROUNDS появится у всех. Можно сначала выложить предпросмотр без `--prod`.

1. Дописать в `C:\Server\memepred\frontend\.env.rhc-testnet` строки из шага 4 (Блокнот сохраняет UTF-8 без BOM; BOM
   или пробел в значении оставит экран выключенным, `VITE_ROUNDS_ENABLED` включает только ровно `1`):

   ```
   notepad C:\Server\memepred\frontend\.env.rhc-testnet
   ```

2. Собрать в отдельную папку:

   ```
   cd /d C:\Server\memepred\frontend
   npx vite build --mode rhc-testnet --outDir C:\Server\rhc-rounds-build\dist
   ```

3. Выкладывать **только из пустой отдельной папки**, привязанной к проекту `flipthememe-rhc`. `frontend\.vercel`
   привязан к проекту Base, `vercel` из самой папки `frontend` не запускать. Если папки выкладки нет, создать и
   привязать, затем убедиться, что в `.vercel\project.json` проект `flipthememe-rhc`:

   ```
   mkdir C:\Server\rhc-site-deploy
   cd /d C:\Server\rhc-site-deploy
   vercel link --yes --project flipthememe-rhc
   type .vercel\project.json
   ```

   (Если CLI не знает флага `--project`, `vercel link` спросит проект сам.) Затем в ней оставить только `.vercel`,
   положить сборку и `vercel.json`, как при выпуске 29.09 (`DEPLOYMENTS.md`, «Повторный выпуск сайта»), и выложить
   предпросмотр:

   ```
   cd /d C:\Server\rhc-site-deploy
   xcopy /E /I /Y C:\Server\rhc-rounds-build\dist C:\Server\rhc-site-deploy\dist
   copy /Y C:\Server\memepred\deploy\vercel.rhc.json C:\Server\rhc-site-deploy\vercel.json
   vercel deploy --yes
   ```

   Это отдельная ссылка, публичный сайт не меняется. В Vercel для предпросмотра включён вход; проверять сам ответ
   можно через `vercel curl /rounds --deployment <URL>` после статуса Ready. Первый предпросмотр без
   `outputDirectory: "dist"` ошибочно отдавал 404; поэтому нужен именно `deploy/vercel.rhc.json`, а не общий
   `frontend/vercel.json`. После проверки выложить боевой
   выпуск из той же папки:

   ```
   vercel deploy --prod --yes
   ```

   Продакшен уже выложен: `dpl_7opSdBYYrnktRQk19RAdohCdfdVy`, `https://rhc.flipthememe.com/rounds`.
   Маршрут, три пула и правила проверены публично. Браузерный кошелёк остаётся отдельной сквозной проверкой.

Экран ищет события от `VITE_ROUNDS_DEPLOY_BLOCK` одним `eth_getLogs` (постраничного обхода нет), поэтому блок
развёртывания задать обязательно.

## Шаг 9. Запись в DEPLOYMENTS.md

Файл правит София (или Claude по её просьбе). Готовый раздел печатает `rounds-deploy.mts after`; его вид (значения из
рабочего вывода, здесь угловые скобки):

```
## Robinhood Chain testnet, PoolRounds (раунды), деплой <дата>

Развёрнуто `contracts/script/DeployPoolRounds.s.sol` через `scripts/rhc/rounds-deploy.mts` из коммита `<коммит>`
(записан в `contracts/broadcast/DeployPoolRounds.s.sol/46630/run-latest.json`), блок <блок>, 9 транзакций,
<газ> газа, <ETH> ETH. Контракты демо от 29.09 не тронуты.

| Контракт | Адрес |
|---|---|
| `PoolRounds` | `<POOL_ROUNDS>` |
| `ReferralRegistry` (новый, фабрика и допуск - `PoolRounds`) | `<РЕЕСТР>` |

Владелец - деплойер, права мультисигу не переданы (`RHC_HANDOVER` не выставлен); `pauser` - кипер. Залистованы
стенд-ин пулы раундов (`PoolRoundMockPool`, своя стенд-ин фабрика, см. `ROUNDS-DEPLOY.md`): <три адреса>.
Верификация исходников: <is_verified по API обозревателя>. Кипер раундов: <где запущен, с какого времени>.
```

И дописать к нему таблицу стенд-инов шага 2 (фабрика раундов, три пула, их токены, глубина 1 000, кольцо 900) и итог
шага 7 (хэши, газ, задержки кипера).

## Откат

Контракт на цепочке удалить нельзя, и владелец не может тронуть деньги игроков (функций спасения нет). Откатить -
значит перестать принимать новые ставки и дать открытым раундам закончиться.

| Что | Как | Что остаётся |
|---|---|---|
| новые ставки | владелец или `pauser`: `pause()`; снять паузу может только владелец. Точечно: `delistPool(pool)`, `setDuration(300, false)` | `fixStrike`, `settle`, `claim`, `withdrawFees`, `claimReferral` работают и на паузе |
| открытые раунды | кипер должен работать до `settleAt` последнего активированного раунда (до 20 минут после последней ставки). Если кипер уже выключен, `settle` может вызвать кто угодно; через 24 ч после `settleAt` раунд без цены закрывается REFUND любым вызовом `settle` | ставки неактивированных раундов забираются `claim` в любой момент после `closeAt` |
| кипер, вариант A | закрыть окно (Ctrl+C) | файл состояния в `scripts\rhc` можно удалить после расчёта всех раундов |
| кипер, вариант B | убрать `ROUNDS_ENABLED=true` из `.env.rhc` и пересоздать `rhc-keeper` (Claude, один заход); без флага модуль раундов даже не загружается, старые рынки работают как раньше | |
| сайт | выложить прежнюю сборку без флага (или в панели Vercel продвинуть предыдущий деплой проекта `flipthememe-rhc`) | контракт и ставки на цепочке остаются видны в обозревателе |
| стенд-ины шага 2 | ничего делать не нужно: своя фабрика, демо и старый кипер их не видят | |

Пауза из cmd (ключ владельца скрипт берёт из `.env` сам, на экран он не попадает):

```
cd /d C:\Server\memepred
set ROUNDS_ADDRESS=0x...
scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts pause --yes-testnet
```

## Чек-лист после развёртывания

Чтение из cmd (`cast call`, ничего не отправляет); ожидаемое справа:

```
set RPC=https://rpc.testnet.chain.robinhood.com
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "owner()(address)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "pauser()(address)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "treasury()(address)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "referralRegistry()(address)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "minCardinality()(uint256)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "gateDepth()(uint256)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "durationEnabled(uint256)(bool)" 300 --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <POOL_ROUNDS> "pools(address)(bool,bool)" <ПУЛ> --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <РЕЕСТР> "marketFactory()(address)" --rpc-url %RPC%
%USERPROFILE%\.foundry\bin\cast.exe call <РЕЕСТР> "authorizedMarkets(address)(bool)" <POOL_ROUNDS> --rpc-url %RPC%
```

- [ ] `owner` = деплойер `0x12f9...8BD2`, `pauser` = кипер `0xbFa0...eea4`, `treasury` = `TREASURY_ADDRESS`
- [ ] `referralRegistry` = новый реестр; у реестра `marketFactory` = `PoolRounds`, `authorizedMarkets(PoolRounds)` = true
- [ ] `minCardinality` 900, `gateDepth` 50000000000000000000, `durationEnabled(300)` true, у каждого пула `pools` = `true, ...`
- [ ] `is_verified: true` у `PoolRounds` и реестра (шаг 5)
- [ ] кипер: в логе строка `PoolRounds keeper on <адрес>`, после первой ставки раунд виден (вариант B: `/api/rounds/health`
      не `off`, `/health/deep` без `rounds-*` кодов)
- [ ] шаг 7: `ALL CHECKS PASSED`, `fixStrike` и `settle` в пределах `keeperDeadlines`, газ кипера по квитанциям
- [ ] демо 29.09 не изменилось: рынки, API, сторож как раньше
- [ ] раздел в `DEPLOYMENTS.md` (шаг 9) и адреса в памяти проекта

## Стоимость

Цена на тестнете 0.01 gwei (минимум цепочки, `ArbGasInfo` 30.09), данные L1 0.35-0.61 gwei за байт. Газ L2 - замер на
anvil, L1 - оценка через `NodeInterface` тестнета (`testnet-gate.md`) и размер кода.

**Развёртывание:**

| Шаг | Газ L2 | L1, оценка | ETH при 0.01 gwei | при 0.1 gwei |
|---|---:|---:|---:|---:|
| 2. стенд-ины: фабрика, 3 пула, регистрация, история, глубина, кольцо | 6.18 млн с тремя новыми токенами (замер), около 4.1 млн на демо-токенах | 0.5-0.75 млн | 0.000046-0.000069 | 0.00046-0.00069 |
| 3. симуляция | 0 | 0 | 0 | 0 |
| 4. развёртывание, 9 транзакций | 5.72 млн (замер репетиции: реестр 730 798, `PoolRounds` 4 492 497, 3 x `listPool` 101 тыс.) | около 0.61 млн | 0.000063 | 0.00063 |
| 5. верификация | 0 | 0 | 0 | 0 |
| **итого** | | | **0.00011-0.00013** | **0.0011-0.0013** |

У деплойера 0.005834 ETH: хватает при цене до ~0.4 gwei. Пополнение для самого развёртывания не нужно; для
варианта A кипера с кошельком деплойера - см. ниже.

**Кипер** (замер на anvil, `e2e-local.log`): на активированный раунд `fixStrike` + `settle` = 188 тыс. газа на свежем
пуле плюс около 14 тыс. L1, **и плюс 14.4 тыс. за каждую записанную ступень цены пула** (стенд-ин перечитывает всю
историю; 866 145 на пуле с 49 записями против 187 809 с двумя). Ставки игроков тоже растут: 2.8 тыс. газа на ступень
(ставка теперь читает пул). Неактивированный раунд кипер не оплачивает. `withdrawFees` 43-61 тыс., только когда
накопилось 0.01 WETH.

| Сценарий в месяц | Раундов | Записей на пул к концу | ETH при 0.01 gwei |
|---|---:|---:|---:|
| только проверки: `rounds-e2e.mts --testnet` раз в день (2 раунда, 1 ступень) | 60 | около 30 на пуле A | около 0.0003 |
| умеренное демо: 10 активированных раундов в день, у каждого одна ступень, три пула | 300 | около 100 | около 0.003 |
| непрерывно: каждое окно 300 с на трёх пулах, ступень на каждый раунд | до 26 тыс. | растёт на 288 в сутки | невозможно: через ~31 ч на пул раунд перестаёт влезать в свой `costAllowance`, до этого около 0.03 ETH (в три раза больше баланса кипера) |

Бюджет раунда (`costAllowance` 69 692 gwei, из них 80% на `fixStrike` и `settle`): при 0.01 gwei это 5.6 млн газа,
раунд влезает, пока на пуле меньше ~370 записей; при 0.07 gwei (p99 мейннета, под который выставлен `costAllowance`)
- меньше ~40. Дальше кипер не шлёт (`rounds-over-budget`), раунд ждёт ветки 24 ч. Лечится новыми стенд-инами
(шаг 2 заново, `listPool` новых, `delistPool` старых) или стенд-ином с чтением O(log n).

**Хватит ли газа:** кипер `0xbFa0...` 0.010932 ETH, общий со старыми рынками (их расчёт на MOONCAT с 48 записями
около 0.6 млн газа, 6 мкETH). Первых двух сценариев хватает на месяцы; непрерывного - нет, и дело не в балансе, а в
истории стенд-инов. Деплойер 0.005834: развёртывание (0.00013) плюс вариант A на умеренном демо (0.003 в месяц) -
около полутора месяцев.

## Что проверено

- **Гейт на настоящем тестнете, только чтением** (`measurements/rounds/testnet-gate.md`): демо-пулы не проходят, и
  «доращивание» не помогает; первый стенд-ин проходит после кольца, но тоже без `secondsPerLiquidity`.
- **Сквозной прогон на anvil** (`measurements/rounds/e2e-local.log`, `scripts/rhc/rounds-e2e.mts --local`): два
  прогона (свежие пулы и пулы с 48 / 32 / 36 записями цены, как у демо сейчас), 73 проверки в каждом, 0 упавших.
  Отказ скрипта на пуле как у демо (`PoolTooThin(40 WETH)`, nonce деплойера
  не сдвинулся), стенд-ины кодом шага 2, развёртывание настоящим `DeployPoolRounds.s.sol` с `--broadcast` (только на
  anvil), проверка связки и параметров против значений по умолчанию из исходника скрипта (`depthPerBank` 2500, `gateDepth`
  50, `minCardinality` 900 и остальные), `maxBankOf` пулов, кипер - настоящий код `backend/src/rounds` импортом, выигрыш ровно 1.96x
  (0.0392), проигравший 0, ничья и REFUND по 0.0099, возврат неактивированного раунда целиком в `closeAt`, реферальная
  доля и `claimReferral`, два `withdrawFees` кипером, баланс контракта 0 после всех выплат. Цена газа на anvil
  приведена к тестнету прокси (0.01 gwei в каждом блоке, без чаевых): иначе anvil отвечает 1 gwei чаевых, и кипер
  отказывался бы по бюджету, чего на тестнете нет.
- **Помощник развёртывания** (`rounds-deploy.mts`): `plan`, `standins`, `simulate`, `deploy`, `after`, `pause` прогнаны
  против локального anvil с chain id 46630 (с `--rpc http://127.0.0.1:...` и временным `.env` с тестовым ключом
  anvil), включая отказы без `--yes-testnet`; записи forge при репетиции уходят во временную папку, не в
  `contracts\broadcast`. Проверка незакоммиченного кода на локальном узле не включается и поэтому не прогонялась.
- **Кипер варианта A** (`rounds-keeper-local.mts`): один тик на том же anvil, отказ от `KEEPER_PRIVATE_KEY`.

## Что не проверено

- **Ничего на тестнете не отправлялось**: `rounds-deploy.mts` против тестнета, `rounds-e2e.mts --testnet` (даже без
  `--yes-testnet`) и `rounds-keeper-local.mts` против тестнета не запускались.
- Верификация на обозревателе (команды и поля формы API - по записи 29.09, не проверены на этом контракте).
- Вариант B кипера (сервер) и выкладка сайта - только описаны.
- Реальная задержка кипера на публичном RPC и газ по квитанциям RHC; L1-часть - оценка.
- Экран раундов против текущей версии контракта (новые ошибки `BankTooLargeForPool`, `PoolAboveGate`, потолок банка
  `maxBankOf`) не проверялся; кипер пишет причину REFUND 4 числом (`REFUND (4)`), в его списке причин нет `thin`.

## Что решить владельцу

1. Запускать ли v2 на тестнете до повторного аудита текущей редакции.
2. Закоммитить контракт и скрипт до шага 4 (иначе верификация из записанного коммита не сойдётся).
3. Где работает кипер: A (машина Софии, кошелёк деплойера) или B (сервер, кошелёк кипера, нужен отдельный заход Claude).
4. Выкладывать ли вкладку ROUNDS на публичный `rhc.flipthememe.com` или только предпросмотр.
5. Чем двигать цену новых пулов: без ступеней все раунды - ничьи; каждая ступень навсегда дорожает чтения. Для демо
   нужен отдельный нормированный двигатель или стенд-ин с чтением O(log n).
6. Глубина новых стенд-инов (по умолчанию `max(1 000, 20 x gateDepth)` = 1 000 WETH): она задаёт потолок банка раунда
   (`maxBankOf` = глубина / `depthPerBank` = 0.4 WETH).
