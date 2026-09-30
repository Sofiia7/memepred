# Замеры для ROUNDS-CONTRACT.md: PoolRounds, интерфейс v3

Снято 2026-09-30 на машине Софии, после правок по повторному аудиту (правило глубины, ликвидность окон, кольцо 900,
`delistIfBelowGate`, чтение реестра). Прежние логи заменены. Инструменты: forge 1.7.1
(коммит `4072e48`, сборка 2026-05-08), solc 0.8.24 (из `contracts/foundry.toml`, оптимизатор 200 прогонов), Node
24.11.1. Сеть не использовалась: ни форка, ни RPC, ни транзакций. Пулы в тестах - стенд-ины
`contracts/test/PoolRoundMockPool.sol` (как `mocks/MockUniswapV3Pool.sol`, плюс история ликвидности и
`secondsPerLiquidityCumulativeX128`) и `RingPool` из `contracts/test/PoolRoundsAttackOracle.t.sol`.

## Файлы

| Файл | Что это |
|---|---|
| `forge-test-all.log` | весь набор `forge test` из `contracts/`: 646 тестов в 51 сьюте, 0 упавших (433 старых + 213 по раундам) |
| `forge-isolate-gas.log` | `PoolRoundsGasTest` под `--isolate`: газ каждой операции при 2, 10 и 50 участниках и оценка бюджета |
| `forge-invariant-coverage.log` | инварианты при капе 1 и 4 с зёрнами 1, 2, 3: таблица вызовов обработчика и сводка последнего прогона |
| `vectors-check.log` | `node scripts/rhc/PoolRoundVectors.mts --check`: 88 векторов в `contracts/test/PoolRoundVectors.t.sol` совпадают с тем, что сейчас даёт эталон |

## Как повторить (cmd)

Весь набор тестов:

```
cd /d C:\Server\memepred\contracts
%USERPROFILE%\.foundry\bin\forge.exe test
```

Газ (числа документа берутся только из этого режима: каждый вызов - отдельная транзакция с холодными слотами,
21 000 базового газа включены, возврат газа уже вычтен):

```
cd /d C:\Server\memepred\contracts
%USERPROFILE%\.foundry\bin\forge.exe test --match-contract PoolRoundsGasTest --isolate -vv
```

Инварианты с выводом покрытия:

```
cd /d C:\Server\memepred\contracts
%USERPROFILE%\.foundry\bin\forge.exe test --match-contract PoolRoundsInvariantCap -vv --fuzz-seed 1
```

Векторы эталона (пересобрать и проверить):

```
cd /d C:\Server\memepred
node scripts\rhc\PoolRoundVectors.mts
node scripts\rhc\PoolRoundVectors.mts --check
```

Скрипт векторов не копирует модель: он читает `scripts/rhc/positive-ev.mts`, отрезает его до первой исполняемой
строки (`const tests = selfTest()`), убирает типы через `node:module` `stripTypeScriptTypes`, импортирует и сначала
прогоняет собственный `selfTest()` эталона (80 000 проверок). Хеш sha256 файла эталона записан в сгенерированный тест;
правка эталона без пересборки векторов даёт `--check` с кодом 1. Векторы сняты с рабочей копии `positive-ev.mts` на
30.09 (sha256 `39bf9a3f...c201`), по 40 случайных книг при капе 1 и при капе 4 плюс 8 книг `selfTest()`.

## Что в замере газа оценка, а не измерение

- **`observe()` настоящего пула.** Стенд-ин проходит короткий список сегментов, настоящий пул ищет двоичным поиском
  по кольцу. Поправка: `2 600 + 41 500 x точек / 3` минус замер стенд-ина из контракта (`ObserveProbe` в тесте).
  41 500 - исполнение `observe()` трёх точек на живом пуле мейннета, из `PoolSettlementGasBench.t.sol`; 2 600 -
  холодный доступ к адресу пула, которого нет в замере верхнего уровня. Линейное масштабирование по точкам -
  допущение. Новый стенд-ин интегрирует ещё и ликвидность и сам стоит 36-61 тыс. газа на `observe`, больше
  этой оценки для 2 и 3 точек; там поправка ноль, и итог получается с запасом. Чтение `slot0` и `liquidity` у
  стенд-ина 23 490 газа, у настоящего пула около 7.5 тыс. (оценка): ставка в замере дороже, чем будет на цепочке.
- **L1-составляющая.** В forge её воспроизвести нельзя: форк не считает плату за данные L1. Взято 13 021 газа на
  транзакцию кипера - наибольшее `gasUsedForL1` квитанций RHC из `ECONOMICS.md` (там же диапазон 10-13 тыс.).
- Точность forge против цепочки по `ECONOMICS.md`: около ±10 тыс. газа на транзакцию.
