# Замеры для ECONOMICS.md: откуда взяты оценки газа

Всё, на чём стоят оценки в [`docs/rhc/ECONOMICS.md`](../../ECONOMICS.md) и константы
[`scripts/rhc/economics.mts`](../../../../scripts/rhc/economics.mts), чтобы их можно было повторить.
Снято 2026-09-29. Инструменты: forge 1.7.1 (коммит `4072e48`, сборка 2026-05-08), solc 0.8.24 (из
`foundry.toml`), Node 24.11.1, viem 2.56.0 (из `scripts/node_modules`).

## Файлы

| Файл | Что это |
|---|---|
| `EconGas.t.sol` | газ каждого исхода расчёта через `resolveOrderbookMarketBatchFrom` на проводке как в `DeployRhc`; реферальные начисления; пачка из 5; `refundExpired`/`cancelOrder`/`emergencyRefundMatch`; итог хранилища за выигрыш и проигрыш |
| `MockGrowth.t.sol` | цена `observe` стенд-ин пула при 4 / 16 / 100 / 500 / 2 000 записях |
| `RefundSemantics.t.sol` | что именно отдаёт `vm.lastCallGas().gasTotalUsed` (ответ: газ за вычетом возврата; под `--isolate` ещё и с 21 000 базового газа) |
| `L04LabelCheck.t.sol` | какой матч создаёт сценарий «PvP» из `contracts/test/L04FeeEconomics.t.sol` (ответ: оба с хранилищем) |
| `foundry.toml` | конфиг временного проекта; библиотеки берутся из репозитория по абсолютным путям `C:/Server/memepred/...` |
| `forge-isolate.log`, `forge-l04-label.log` | сырой вывод прогонов ниже, 29.09 |
| `chain-probe.mjs`, `chain-probe.log` | квитанции e2e 29.09 (`gasUsed`, `gasUsedForL1`), размер подписанной транзакции до и после brotli, записи пулов, балансы, цены `ArbGasInfo` обеих цепочек; только чтение |
| `explorer-txs.mjs`, `explorer-txs.log` | транзакции кипера, деплойера и минтера за 29.09 из API обозревателя тестнета, по методам |
| `basefee-history.mjs`, `basefee-26d.json`, `basefee-24h.json` | `baseFeePerGas` мейннета 4663 по заголовкам блоков: раз в час с 03.09 (625 точек) и раз в 10 минут за последние сутки (145 точек) |

## Как повторить (cmd)

Forge-тесты лежат здесь, а не в `contracts/test`: это замер, а не проверка, и в общий прогон они не должны
попадать. Их запускают во временной копии проекта:

```
set SCRATCH=%TEMP%\ftm-econ-gas
mkdir %SCRATCH%\test
xcopy /E /I /Y C:\Server\memepred\contracts\src %SCRATCH%\src
xcopy /E /I /Y C:\Server\memepred\contracts\test\mocks %SCRATCH%\test\mocks
copy /Y C:\Server\memepred\contracts\test\L04FeeEconomics.t.sol %SCRATCH%\test\
copy /Y C:\Server\memepred\docs\rhc\measurements\economics\*.t.sol %SCRATCH%\test\
copy /Y C:\Server\memepred\docs\rhc\measurements\economics\foundry.toml %SCRATCH%\
cd /d %SCRATCH%
%USERPROFILE%\.foundry\bin\forge.exe test --isolate -vv --match-contract "EconGasTest|MockGrowthTest|RefundSemanticsTest"
%USERPROFILE%\.foundry\bin\forge.exe test -vv --match-test test_WhatThePvPTestActuallyMatches
```

Цепочка (из корня репозитория, только чтение):

```
cd /d C:\Server\memepred
node docs\rhc\measurements\economics\chain-probe.mjs
node docs\rhc\measurements\economics\explorer-txs.mjs 0xbFa008e5A8d46d2014b83551ce6209108416eea4 2026-09-29T00:00:00Z
node docs\rhc\measurements\economics\basefee-history.mjs 26 60 basefee-26d.json
```

## Как из этого получены числа документа

- **Читать `gasTotalUsed`, не вычитать возврат.** Под `--isolate` каждый вызов идёт отдельной транзакцией с
  холодными слотами, и `vm.lastCallGas().gasTotalUsed` уже включает 21 000 базового газа и уже за вычетом
  возврата (`RefundSemantics.t.sol`: запись и стирание слота дают 23 422, одна запись 43 300). Первая версия
  ECONOMICS.md вычитала возврат второй раз; из-за этого первое реферальное начисление было 85 904 вместо
  66 004, ничьи и маржинальный матч пачки тоже были сдвинуты.
- **Сверка с цепочкой.** PvP-расчёт в forge 278 061, на цепочке 293 038 минус 13 021 L1 = 280 017 (0.7%).
  Возврат хранилища против его выигрыша: forge -63 858, цепочка -71 962, отсюда точность оценок около ±10 тыс.
- **Оценка исхода** = L2-часть живой квитанции того же типа матча + разница forge между исходами:
  проигрыш игрока хранилищу 277 616 + (310 296 - 294 699) = 293 213; ничья PvP 280 017 + (239 485 - 278 061) =
  241 441; ничья с хранилищем 277 616 + (242 265 - 294 699) = 225 182; возврат PvP 280 017 + (275 335 - 278 061) =
  277 291 (от возврата хранилища выходит 250 148); `refundExpired` 79 293 + (117 282 - 93 024) = 103 551.
- **Реферал** (все против PvP-расчёта 278 061): первое начисление на новом распределителе 344 065 (+66 004),
  первое начисление нового реферера, когда в распределителе уже лежат реферальные WETH, 309 865 (+31 804),
  повторное тому же рефереру 292 765 (+14 704). Расчёт без реферала в том же состоянии остаётся 278 061.
- **Пачка:** 5 PvP-матчей 965 507, маржинальный матч (965 507 - 278 061) / 4 = 171 862.
- **L1-часть:** `gasUsedForL1` из квитанций (13 021 у PvP-расчёта, 10 255 у расчёта с хранилищем и у возврата,
  8 385 у `cancelOrder`). На мейннете она считается как байты x `perL1CalldataByte`: подписанный расчёт 177 байт,
  181 после brotli уровня 0 и 1 (уровень, которым сжимает ArbOS этой цепочки, не проверен). По квитанциям
  тестнета плата за байт в момент e2e выходит 0.57-0.72 gwei, в момент чтения 29.09 было 0.26-0.50: цена L1 плавает.
- **Стенд-ин пулы:** по цепочке 8 356 газа на запись (MOONCAT 16 записей 172 438, FROGGO 4 записи 72 171 на
  `observe` трёх точек), forge 8 240 (`MockGrowth.t.sol`).
