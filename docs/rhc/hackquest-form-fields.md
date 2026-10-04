# HackQuest: что куда вставлять

Подготовлено 4 октября 2026 по присланным скриншотам. Ниже — готовые английские значения. В заявку ничего автоматически не отправлено. Дедлайн: **сегодня, 4 октября, 17:59 по Белграду**. [Официальная страница](https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon).

## 1. Project → Overview

### Name

```text
FlipTheMeme
```

### Intro

```text
UP or DOWN on the meme coin you follow. FlipTheMeme brings pool-priced prediction rounds to Robinhood Chain, with one-transaction ETH staking and on-chain payouts. A working testnet prototype.
```

### Logo

Используй жёлто-зелёный значок FlipTheMeme из `artifacts/live-demo/final/project-logo.png`. Это наш значок, не логотип Robinhood.

### Demo Video

Загрузи `artifacts/live-demo/final/FlipTheMeme-live-demo-Ava.mp4` кнопкой загрузки. Если интерфейс требует ссылку, сначала загрузи этот файл на YouTube с доступом по ссылке, затем вставь URL. Проверь доступ без авторизации. Не вставляй локальный путь в поле URL.

### Pitch Video

Загрузи `artifacts/live-demo/final/FlipTheMeme-pitch-Ava.mp4`. Это короткая версия про продукт и его ценность; Demo Video показывает пользовательский сценарий подробнее.

### GitHub Link

```text
https://github.com/Sofiia7/memepred/tree/robinhood-chain
```

Перед отправкой открой репозиторий, как планировала. Указана именно ветка `robinhood-chain`, в которой лежит версия для заявки.

### Product Category

Выбери **DeFi** и **Gaming**. Третья категория не обязательна.

### Description

Вставь весь следующий текст в большой редактор Description:

```text
FlipTheMeme lets people who enjoy Polymarket-style outcome betting call UP or DOWN on the specific meme coin they follow, without buying or shorting it. It is built for Robinhood Chain's on-chain token ecosystem: a coin's own liquidity pool supplies the price rule, rather than requiring a separately listed asset-specific oracle.

How it works

A new betting round opens every five minutes. Players stake ETH directly in one wallet transaction; the contract wraps it internally, so there is no separate swap or token approval. UP and DOWN stakes are matched one to one. Only the matched portion plays, while any excess is refundable without a fee. If there is not enough opposing stake to activate the round, every stake is refundable in full.

The outcome compares a future strike average with an exit price. After betting closes, the protocol waits five minutes, averages the strike over one minute, and reads the exit five minutes later. The result is due sixteen minutes after the round opens. Movement before the strike does not determine the result. A winner receives 1.96x the accepted stake; a tie returns the accepted stake minus a 1% fee. Players collect payouts or refunds in native ETH.

Why this architecture

The same pool provides both the price history and the depth used to limit the round's bank. PoolRounds checks depth and observation capacity, caps the accepted bank, handles unavailable price windows, and funds payouts from opposing players' stakes. Settlement is permissionless, with a server keeper performing it normally. These checks constrain exposure; they do not eliminate pool-price manipulation.

What is live

The browser application, verified PoolRounds contract, keeper and three demo pools are deployed on Robinhood Chain testnet, chain ID 46630. The demo uses test ETH and explicitly labeled, predictable simulated pool prices. A live browser recording demonstrates two founder wallets taking opposite sides, a DOWN result, and collection of 0.0098 ETH from a winning 0.005 ETH stake. These are founder tests, not organic user traction.

Validation includes a deployed testnet end-to-end run with 40 checks and zero failures, native ETH entry and collection tests, and local mainnet-fork tests against a canonical RMHT/WETH v3 pool. The fork checks include a locally simulated swap, directional settlement and winner collection. They are local simulations, not a mainnet launch.

Next milestone

Test whether independent meme-coin community members understand the strike timing, provide opposing flow and return for another round. The current contracts are unaudited. Real-money deployment requires further security and economic validation.

Try the demo: https://rhc.flipthememe.com/rounds
Verified contract: https://explorer.testnet.chain.robinhood.com/address/0x1e928adc9de612b08f78824417d4f5ef354c66d7
Keeper health: https://api-rhc.flipthememe.com/api/rounds/health
Source and reproducible evidence: https://github.com/Sofiia7/memepred/tree/robinhood-chain
```

### Progress During Buildathon

```text
Built the Robinhood Chain PoolRounds protocol with public UP/DOWN stakes, a 1:1 matched bank, future strike averaging, pool-depth limits, refunds and permissionless settlement. Added direct ETH staking and ETH collection, deployed and verified the contracts, and connected the server keeper. Shipped the desktop/mobile interface, pool history charts, persistent sharing and a dedicated My bets screen. Completed the deployed testnet run (40 checks, zero failures), native ETH tests, real-pool local fork checks, and a live two-wallet browser demo with winner collection. Added continuous, explicitly simulated testnet price feeds that do not expire after an hour.
```

### Tech Stack (максимум 8)

Из существующих кнопок: **React**, **Node**, **Solidity**. Через **Add new**: **TypeScript**, **viem**, **Foundry**, **PostgreSQL**, **Redis**. Итого восемь. Не выбирай Next, Ethers или Web3.js: они не описывают основной стек этой версии.

### Fundraising Status

Если внешних инвестиций или грантов не привлекала, вставь:

```text
Bootstrapped. No external funding raised to date. Seeking milestone-based support for independent user testing, security review and further Robinhood Chain development.
```

Если финансирование было, замени первые два предложения фактическими данными — этот личный факт я не могу подтвердить по коду.

### Wallet

Нажми **Connect Wallet** и подключи свой кошелёк участника/основателя, который будешь использовать для этой заявки. Здесь не нужно вводить адрес PoolRounds или тестового токена. Подтверждай только понятное подключение/подпись авторизации платформы.

### Team

Проверь отображение своего имени и состава команды. Если работаешь одна, не добавляй вымышленных участников. При наличии поля Bio можно написать:

```text
Solo founder building FlipTheMeme's product and Robinhood Chain implementation, with AI-assisted development and testing.
```

Сохрани **Save Changes**, затем переходи к сабмишну.

## 2. Submission

### Which Prize Track Do You Belong To (select all that apply)

Выбери **Overall Prize**, **Promising Products Track**, **Grants**. Форма допускает несколько вариантов; опубликованные правила позволяют оценивать развёрнутый проект в первых двух направлениях. Grants — отдельное рассмотрение поддержки по этапам. Это выбор направления оценки, не утверждение о выигранном гранте.

### Link to frontend/UI/website of your project

```text
https://rhc.flipthememe.com/rounds
```

### List your Core Protocol/Smart Contract Addresses

```text
Robinhood Chain testnet (46630)
PoolRounds: 0x1e928adc9de612b08f78824417d4f5ef354c66d7
ReferralRegistry: 0xbd68ee0f3c7ef3bc8df701e1557895526358c6a7
```

### List your Factory/Pool Contracts (if applicable)

Это действующие пулы, а не снятые с приёма ставок старые адреса:

```text
Demo factory: 0x297d37aE9eF9747B2F040DDfB16Cb694Bb73034B
FROGGO: 0x9935aef7659f1c30843f0c959c349304f1bccfbe
MOONCAT: 0x0cc364d14046c3096ac247a7cc8bbb092024d186
PEPE: 0xc6dea87acb96a968cac414ebf9d98fc9092478d9
```

### List your Token Contract Address (if applicable)

```text
Testnet demo tokens; no project token.
TestWETH: 0x702431c8Ef4E21Fc4180C8395A4B0f3464b7d5A3
FROGGO: 0xa1cF709d63f5C1f3e9E81Fd7abFA56ef3F8c0B94
MOONCAT: 0xDf1F40c97e6F191f1cEbd5Bec7678136a24522Cc
PEPE: 0xC12B7F3F9667c69075a89d3151153CE8E1EE6B4B
```

### Which parts of your code have been produced during the Buildathon?

```text
Built PoolRounds, native ETH entry/collection, pool-depth and oracle checks, keeper/indexer integration, rounds UI, charts, sharing and continuous simulated demo oracles. Added fuzz/invariant, testnet end-to-end and real-pool fork tests. Reused existing app infrastructure.
```

### Which sponsor/partner technologies have you used as part of your project?

Выбери **Robinhood Chain** и **OpenZeppelin**. Не отмечай USDG, GMX, Dune, ZeroDev, Fhenix, Alchemy или AWS: для этой заявки их интеграция не подтверждена.

## 3. Перед Submit

1. Репозиторий открыт и указанная ветка доступна без авторизации.
2. Оба видео загружены и воспроизводятся без аккаунта автора.
3. Проект сохранён, обязательные поля заполнены, кошелёк подключён.
4. Ссылки и адреса скопированы полностью; сайт — `rhc.flipthememe.com/rounds`.
5. После Submit дождись подтверждения отправки; сохранённый проект сам по себе не является отправленным сабмишном.

Данные в текстовых полях Submission выше проверяются на лимит **300 символов**. Дедлайн: **4 октября 2026, 17:59 Белград / Будапешт** (15:59 UTC, 23:59 Сингапур).
