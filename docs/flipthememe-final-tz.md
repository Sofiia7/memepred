# FlipTheMeme — Полное ТЗ с кодом
# PvP Prediction Market · мем-коины · Base chain · USDC
# Версия 3.0 — финальная · Март 2026
# Готово для Cursor / Codex

---

## КОНТЕКСТ ДЛЯ AI-АССИСТЕНТА

Ты помогаешь строить **FlipTheMeme** — децентрализованный PvP prediction market на мем-коины.
Пользователи ставят USDC на рост или падение мем-коина за выбранный таймфрейм (5м/15м/1ч/4ч/24ч).
Победители делят банк проигравших. Протокол берёт 0% на старте, затем 0.5%.

**Стек:** Solidity + Foundry · React 18 + Vite · wagmi v2 + viem · Fastify · PostgreSQL · Redis · The Graph · Pyth Network · Base chain · Cloudflare Workers

**Принципы:**
- Non-custodial: USDC хранится в контракте, команда не может вывести
- Trustless: результат определяет оракул автоматически
- Mobile-first: Pump.fun эстетика — чёрный фон, зелёный/красный, JetBrains Mono
- Гео-блок США/EU с первого дня

---

## СТРУКТУРА РЕПОЗИТОРИЯ

```
flipthememe/
├── contracts/          # Solidity · Foundry
├── frontend/           # React · Vite
├── backend/            # Node.js · Fastify
├── subgraph/           # The Graph
├── workers/            # Cloudflare Workers
└── scripts/            # Deploy · Keeper
```

---

---

# ЧАСТЬ 1: SMART CONTRACTS

---

## Структура contracts/

```
contracts/
├── foundry.toml
├── .env.example
├── src/
│   ├── PvPMarket.sol
│   ├── MarketFactory.sol
│   ├── OracleResolver.sol
│   ├── FeeDistributor.sol
│   ├── ReferralRegistry.sol
│   ├── BadgeNFT.sol
│   └── interfaces/
│       ├── IPyth.sol
│       └── IMarket.sol
├── test/
│   ├── PvPMarket.t.sol
│   ├── OracleResolver.t.sol
│   ├── ReferralRegistry.t.sol
│   └── mocks/
│       ├── MockPyth.sol
│       └── MockUSDC.sol
└── script/
    ├── Deploy.s.sol
    └── CreateMarket.s.sol
```

---

## contracts/foundry.toml

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
via_ir = true

[profile.default.fuzz]
runs = 1000
max_test_rejects = 65536

[rpc_endpoints]
base_mainnet = "${BASE_RPC_URL}"
base_sepolia  = "https://sepolia.base.org"

[etherscan]
base = { key = "${BASESCAN_API_KEY}", url = "https://api.basescan.org/api" }
```

---

## contracts/src/interfaces/IMarket.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarket {
    enum Direction { UP, DOWN }
    enum Status { OPEN, CLOSED, RESOLVED, REFUNDED }

    struct Bet {
        address trader;
        uint256 amount;
        Direction direction;
        address referrer;
        bool claimed;
    }

    event BetPlaced(
        address indexed trader,
        Direction direction,
        uint256 amount,
        address referrer,
        uint256 timestamp
    );

    event MarketSettled(
        bool upWon,
        uint256 entryPrice,
        uint256 exitPrice,
        uint256 totalUpPool,
        uint256 totalDownPool
    );

    event Claimed(address indexed trader, uint256 payout);
    event EmergencyRefund(address indexed trader, uint256 amount);

    function placeBet(
        Direction dir,
        uint256 amount,
        address referrer
    ) external;

    function settle(bool upWon) external;
    function claim() external;
    function emergencyRefund() external;

    function totalUpPool() external view returns (uint256);
    function totalDownPool() external view returns (uint256);
    function status() external view returns (Status);
    function marketCloseTime() external view returns (uint256);
    function pythFeedId() external view returns (bytes32);
    function entryPrice() external view returns (uint256);
}
```

---

## contracts/src/PvPMarket.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IMarket.sol";

/**
 * @title PvPMarket
 * @notice Один рынок: пользователи ставят USDC на UP или DOWN.
 *         Победители делят банк проигравших минус FEE.
 *         Деплоится MarketFactory для каждой монеты/таймфрейма.
 */
contract PvPMarket is IMarket, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant FEE_BPS        = 0;    // TODO: сменить на 50 (0.5%) после 3 мес
    uint256 public constant MIN_BET        = 1e6;  // 1 USDC (6 decimals)
    uint256 public constant MAX_BET        = 100e6;// 100 USDC — снять после аудита
    uint256 public constant MIN_POOL_SIDE  = 100e6;// минимум 100 USDC на стороне для резолюции
    uint256 public constant GRACE_PERIOD   = 1 hours; // если не зарезолвлен → refund

    // ── IMMUTABLES ─────────────────────────────────────────
    IERC20  public immutable usdc;
    address public immutable resolver;
    address public immutable feeDistributor;
    address public immutable multisig;

    uint256 public immutable marketOpenTime;
    uint256 public immutable marketCloseTime;
    uint256 public immutable duration;
    bytes32 public immutable pythFeedId;

    // ── STATE ──────────────────────────────────────────────
    Status  public status;
    bool    public upWon;
    uint256 public entryPrice;
    uint256 public exitPrice;
    uint256 public totalUpPool;
    uint256 public totalDownPool;

    Bet[] public upBets;
    Bet[] public downBets;

    mapping(address => uint256) public upBetIndex;   // trader => index+1 (0 = no bet)
    mapping(address => uint256) public downBetIndex;

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(
        address _usdc,
        address _resolver,
        address _feeDistributor,
        address _multisig,
        uint256 _duration,
        bytes32 _pythFeedId,
        uint256 _entryPrice
    ) {
        usdc            = IERC20(_usdc);
        resolver        = _resolver;
        feeDistributor  = _feeDistributor;
        multisig        = _multisig;
        duration        = _duration;
        pythFeedId      = _pythFeedId;
        entryPrice      = _entryPrice;

        marketOpenTime  = block.timestamp;
        marketCloseTime = block.timestamp + _duration;
        status          = Status.OPEN;
    }

    // ── MODIFIERS ──────────────────────────────────────────
    modifier onlyResolver() {
        require(msg.sender == resolver, "only resolver");
        _;
    }

    modifier onlyOpen() {
        require(status == Status.OPEN, "market not open");
        require(block.timestamp < marketCloseTime, "market closed");
        _;
    }

    modifier onlyResolved() {
        require(status == Status.RESOLVED, "not resolved");
        _;
    }

    modifier onlyMultisig() {
        require(msg.sender == multisig, "only multisig");
        _;
    }

    // ── PLACE BET ──────────────────────────────────────────
    /**
     * @notice Разместить ставку.
     * @param dir      UP или DOWN
     * @param amount   Сумма в USDC (минимум MIN_BET)
     * @param referrer Адрес реферера (address(0) если нет)
     */
    function placeBet(
        Direction dir,
        uint256 amount,
        address referrer
    ) external override nonReentrant whenNotPaused onlyOpen {
        require(amount >= MIN_BET, "below min bet");
        require(amount <= MAX_BET, "above max bet"); // TODO: убрать после аудита
        require(referrer != msg.sender, "self referral");

        // Проверить что у трейдера нет ставки на эту сторону
        if (dir == Direction.UP) {
            require(upBetIndex[msg.sender] == 0, "already bet UP");
        } else {
            require(downBetIndex[msg.sender] == 0, "already bet DOWN");
        }

        // Перевести USDC от трейдера на контракт
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Записать ставку
        Bet memory bet = Bet({
            trader:    msg.sender,
            amount:    amount,
            direction: dir,
            referrer:  referrer,
            claimed:   false
        });

        if (dir == Direction.UP) {
            upBets.push(bet);
            upBetIndex[msg.sender] = upBets.length; // index+1
            totalUpPool += amount;
        } else {
            downBets.push(bet);
            downBetIndex[msg.sender] = downBets.length;
            totalDownPool += amount;
        }

        emit BetPlaced(msg.sender, dir, amount, referrer, block.timestamp);
    }

    // ── SETTLE ─────────────────────────────────────────────
    /**
     * @notice Вызывается OracleResolver после закрытия рынка.
     * @param _upWon   true если цена выросла
     */
    function settle(bool _upWon) external override onlyResolver {
        require(status == Status.CLOSED || block.timestamp >= marketCloseTime, "not closed");
        require(status != Status.RESOLVED, "already resolved");

        // Минимальный объём — иначе refund
        if (totalUpPool < MIN_POOL_SIDE || totalDownPool < MIN_POOL_SIDE) {
            status = Status.REFUNDED;
            return;
        }

        upWon  = _upWon;
        status = Status.RESOLVED;

        uint256 totalPool = totalUpPool + totalDownPool;
        uint256 fee = (totalPool * FEE_BPS) / 10_000;

        // Отправить fee дистрибьютору
        if (fee > 0) {
            usdc.safeTransfer(feeDistributor, fee);
            // TODO: вызвать FeeDistributor.receiveFee(fee, winnerBets)
        }

        emit MarketSettled(_upWon, entryPrice, exitPrice, totalUpPool, totalDownPool);
    }

    // ── CLAIM ──────────────────────────────────────────────
    /**
     * @notice Пользователь сам забирает выигрыш (pull pattern).
     */
    function claim() external override nonReentrant onlyResolved {
        uint256 idx;
        bool isWinner;

        if (upWon) {
            idx = upBetIndex[msg.sender];
            require(idx > 0, "no winning bet");
            isWinner = true;
        } else {
            idx = downBetIndex[msg.sender];
            require(idx > 0, "no winning bet");
            isWinner = true;
        }

        Bet storage bet = upWon ? upBets[idx - 1] : downBets[idx - 1];
        require(!bet.claimed, "already claimed");
        bet.claimed = true;

        uint256 totalPool   = totalUpPool + totalDownPool;
        uint256 fee         = (totalPool * FEE_BPS) / 10_000;
        uint256 winnerPool  = upWon ? totalUpPool : totalDownPool;
        uint256 payoutPool  = totalPool - fee;

        // Пропорциональная выплата
        uint256 payout = (bet.amount * payoutPool) / winnerPool;

        usdc.safeTransfer(msg.sender, payout);
        emit Claimed(msg.sender, payout);
    }

    // ── EMERGENCY REFUND ───────────────────────────────────
    /**
     * @notice Если рынок не зарезолвлен через GRACE_PERIOD — любой получает refund.
     */
    function emergencyRefund() external override nonReentrant {
        require(
            block.timestamp > marketCloseTime + GRACE_PERIOD,
            "grace period not over"
        );
        require(status != Status.RESOLVED, "already resolved");

        status = Status.REFUNDED;

        // Вернуть ставку UP
        uint256 upIdx = upBetIndex[msg.sender];
        if (upIdx > 0) {
            Bet storage upBet = upBets[upIdx - 1];
            if (!upBet.claimed) {
                upBet.claimed = true;
                usdc.safeTransfer(msg.sender, upBet.amount);
                emit EmergencyRefund(msg.sender, upBet.amount);
            }
        }

        // Вернуть ставку DOWN
        uint256 downIdx = downBetIndex[msg.sender];
        if (downIdx > 0) {
            Bet storage downBet = downBets[downIdx - 1];
            if (!downBet.claimed) {
                downBet.claimed = true;
                usdc.safeTransfer(msg.sender, downBet.amount);
                emit EmergencyRefund(msg.sender, downBet.amount);
            }
        }
    }

    // ── ADMIN ──────────────────────────────────────────────
    function pause()   external onlyMultisig { _pause(); }
    function unpause() external onlyMultisig { _unpause(); }

    function setExitPrice(uint256 _exitPrice) external onlyResolver {
        exitPrice = _exitPrice;
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getBetsCount() external view returns (uint256 up, uint256 down) {
        return (upBets.length, downBets.length);
    }

    function getOdds() external view returns (uint256 upOdds, uint256 downOdds) {
        uint256 total = totalUpPool + totalDownPool;
        if (total == 0) return (2e18, 2e18); // 2.0x если пусто
        upOdds   = total * 1e18 / (totalUpPool   == 0 ? 1 : totalUpPool);
        downOdds = total * 1e18 / (totalDownPool == 0 ? 1 : totalDownPool);
    }

    function timeLeft() external view returns (uint256) {
        if (block.timestamp >= marketCloseTime) return 0;
        return marketCloseTime - block.timestamp;
    }
}
```

---

## contracts/src/MarketFactory.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./PvPMarket.sol";

/**
 * @title MarketFactory
 * @notice Создаёт рынки через EIP-1167 minimal proxy (дешевле в 10x).
 *         Keeper вызывает createMarket() каждые N минут.
 */
contract MarketFactory is Ownable {
    using Clones for address;

    // ── CONFIG ─────────────────────────────────────────────
    address public immutable implementation; // PvPMarket template
    address public immutable usdc;
    address public immutable resolver;
    address public immutable feeDistributor;
    address public immutable multisig;

    // feedId → список активных рынков
    mapping(bytes32 => address[]) public activeMarkets;

    // Разрешённые taймфреймы в секундах
    uint256[] public allowedDurations = [5 minutes, 15 minutes, 1 hours, 4 hours, 24 hours];

    // Whitelist монет
    mapping(bytes32 => bool) public allowedFeeds;
    bytes32[] public feedIds;

    event MarketCreated(
        address indexed market,
        bytes32 indexed feedId,
        uint256 duration,
        uint256 entryPrice
    );

    constructor(
        address _usdc,
        address _resolver,
        address _feeDistributor,
        address _multisig
    ) Ownable(msg.sender) {
        usdc           = _usdc;
        resolver       = _resolver;
        feeDistributor = _feeDistributor;
        multisig       = _multisig;

        // Деплоим template
        implementation = address(new PvPMarket(
            _usdc, _resolver, _feeDistributor, _multisig, 0, bytes32(0), 0
        ));
    }

    // ── CREATE MARKET ──────────────────────────────────────
    /**
     * @notice Создать новый рынок через minimal proxy.
     * @param feedId      Pyth price feed ID монеты
     * @param duration    Длительность в секундах
     * @param entryPrice  Цена открытия из OracleResolver
     */
    function createMarket(
        bytes32 feedId,
        uint256 duration,
        uint256 entryPrice
    ) external returns (address market) {
        require(msg.sender == resolver || msg.sender == owner(), "unauthorized");
        require(allowedFeeds[feedId], "feed not whitelisted");
        require(_isDurationAllowed(duration), "duration not allowed");

        // Clone и инициализировать
        market = implementation.clone();
        // TODO: заменить на initializable pattern если нужен clone
        // PvPMarket(market).initialize(...)

        activeMarkets[feedId].push(market);
        emit MarketCreated(market, feedId, duration, entryPrice);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function addFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = true;
        feedIds.push(feedId);
    }

    function removeFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = false;
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getActiveMarkets(bytes32 feedId) external view returns (address[] memory) {
        return activeMarkets[feedId];
    }

    function _isDurationAllowed(uint256 dur) internal view returns (bool) {
        for (uint i = 0; i < allowedDurations.length; i++) {
            if (allowedDurations[i] == dur) return true;
        }
        return false;
    }
}
```

---

## contracts/src/OracleResolver.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IPyth.sol";
import "./interfaces/IMarket.sol";
import "./PvPMarket.sol";

/**
 * @title OracleResolver
 * @notice Читает Pyth, считает TWAP, вызывает settle() на рынках.
 *         Вызывается keeper-ом каждые N минут.
 */
contract OracleResolver is Ownable, AccessControl {

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IPyth public immutable pyth;

    // TWAP: feedId → массив {price, timestamp}
    struct PricePoint { uint256 price; uint256 ts; }
    mapping(bytes32 => PricePoint[]) public priceHistory;

    uint256 public constant TWAP_WINDOW = 5 minutes;
    uint256 public constant MAX_PRICE_AGE = 60; // секунд
    uint256 public constant MAX_SPREAD_BPS = 200; // 2% — если больше → отмена рынка

    event PriceRecorded(bytes32 indexed feedId, uint256 price, uint256 ts);
    event MarketResolved(address indexed market, bool upWon, uint256 entry, uint256 exit);
    event MarketRefunded(address indexed market, string reason);

    constructor(address _pyth) Ownable(msg.sender) {
        pyth = IPyth(_pyth);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ── RECORD PRICE ───────────────────────────────────────
    /**
     * @notice Записать текущую цену в историю (вызывать каждые 30 сек keeper-ом).
     * @param feedId           Pyth feed ID
     * @param priceUpdateData  Bytes от Pyth Hermes API
     */
    function recordPrice(
        bytes32 feedId,
        bytes[] calldata priceUpdateData
    ) external onlyRole(KEEPER_ROLE) {
        uint256 updateFee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: updateFee}(priceUpdateData);

        PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
        uint256 price = _normalizePrice(p);

        priceHistory[feedId].push(PricePoint({price: price, ts: block.timestamp}));
        // Чистить старые точки (старше 10 минут)
        _cleanHistory(feedId);

        emit PriceRecorded(feedId, price, block.timestamp);
    }

    // ── RESOLVE MARKET ─────────────────────────────────────
    /**
     * @notice Зарезолвить рынок. Вызывается keeper-ом после закрытия.
     * @param market           Адрес PvPMarket
     * @param priceUpdateData  Свежие данные от Pyth Hermes
     */
    function resolveMarket(
        address market,
        bytes[] calldata priceUpdateData
    ) external onlyRole(KEEPER_ROLE) {
        IMarket m = IMarket(market);
        require(m.status() == IMarket.Status.OPEN || block.timestamp >= m.marketCloseTime(), "not ready");
        require(block.timestamp >= m.marketCloseTime(), "market still open");

        bytes32 feedId = m.pythFeedId();

        // Получить свежую цену
        uint256 updateFee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: updateFee}(priceUpdateData);

        // TWAP exit price
        uint256 exitTwap = _getTWAP(feedId);
        uint256 entryPrice = m.entryPrice();

        // Проверка аномалии: если spread > 2% с последней spot-ценой → refund
        PythStructs.Price memory spot = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
        uint256 spotPrice = _normalizePrice(spot);
        if (_spread(exitTwap, spotPrice) > MAX_SPREAD_BPS) {
            // Нестабильная цена — рынок возвращает ставки
            emit MarketRefunded(market, "oracle spread too high");
            return;
        }

        // Цена не изменилась (edge case) — refund
        if (exitTwap == entryPrice) {
            emit MarketRefunded(market, "price unchanged");
            return;
        }

        bool upWon = exitTwap > entryPrice;
        PvPMarket(market).setExitPrice(exitTwap);
        PvPMarket(market).settle(upWon);

        emit MarketResolved(market, upWon, entryPrice, exitTwap);
    }

    // ── TWAP ───────────────────────────────────────────────
    function _getTWAP(bytes32 feedId) internal view returns (uint256) {
        PricePoint[] storage history = priceHistory[feedId];
        uint256 cutoff = block.timestamp - TWAP_WINDOW;
        uint256 sum = 0;
        uint256 count = 0;

        for (uint256 i = history.length; i > 0; i--) {
            if (history[i-1].ts < cutoff) break;
            sum += history[i-1].price;
            count++;
        }

        require(count > 0, "no price data");
        return sum / count;
    }

    function _spread(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 10_000;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / ((a + b) / 2);
    }

    function _normalizePrice(PythStructs.Price memory p) internal pure returns (uint256) {
        // Pyth возвращает price * 10^expo, нормализуем к 1e18
        int32 expo = p.expo;
        uint256 price = uint256(int256(p.price));
        if (expo < 0) {
            uint256 divisor = 10 ** uint32(-expo);
            return price * 1e18 / divisor;
        } else {
            return price * 1e18 * (10 ** uint32(expo));
        }
    }

    function _cleanHistory(bytes32 feedId) internal {
        uint256 cutoff = block.timestamp - 10 minutes;
        PricePoint[] storage history = priceHistory[feedId];
        uint256 i = 0;
        while (i < history.length && history[i].ts < cutoff) i++;
        if (i > 0) {
            for (uint256 j = 0; j < history.length - i; j++) {
                history[j] = history[j + i];
            }
            for (uint256 j = 0; j < i; j++) history.pop();
        }
    }

    // Keeper может пополнять ETH для оплаты Pyth updates
    receive() external payable {}

    function addKeeper(address keeper) external onlyOwner {
        _grantRole(KEEPER_ROLE, keeper);
    }
}
```

---

## contracts/src/ReferralRegistry.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ReferralRegistry
 * @notice On-chain реестр реферальных связей.
 *         Вызывается из PvPMarket.placeBet при первой ставке реферала.
 */
contract ReferralRegistry is Ownable {

    // referee → referrer (once set, forever)
    mapping(address => address) public referrerOf;
    mapping(address => address[]) public referralsOf;

    // refCode → referrer address
    mapping(bytes6 => address) public codeToReferrer;
    mapping(address => bytes6) public referrerToCode;

    event ReferralRegistered(address indexed referee, address indexed referrer);
    event RefCodeGenerated(address indexed referrer, bytes6 code);

    // ── REGISTER ───────────────────────────────────────────
    /**
     * @notice Зарегистрировать связь реферер → реферал.
     *         Вызывается только из авторизованных контрактов (PvPMarket).
     */
    mapping(address => bool) public authorizedMarkets;

    modifier onlyAuthorized() {
        require(authorizedMarkets[msg.sender] || msg.sender == owner(), "unauthorized");
        _;
    }

    function register(address referee, address referrer) external onlyAuthorized {
        if (referrer == address(0)) return;
        if (referrerOf[referee] != address(0)) return; // already set
        require(referee != referrer, "self referral");

        referrerOf[referee] = referrer;
        referralsOf[referrer].push(referee);

        emit ReferralRegistered(referee, referrer);
    }

    // ── GENERATE CODE ──────────────────────────────────────
    function generateCode(address referrer) external returns (bytes6 code) {
        require(referrerToCode[referrer] == bytes6(0), "code exists");

        // Генерировать уникальный 6-байтовый код
        code = bytes6(keccak256(abi.encodePacked(referrer, block.timestamp, blockhash(block.number - 1))));
        codeToReferrer[code] = referrer;
        referrerToCode[referrer] = code;

        emit RefCodeGenerated(referrer, code);
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getReferrer(address referee) external view returns (address) {
        return referrerOf[referee];
    }

    function getReferralCount(address referrer) external view returns (uint256) {
        return referralsOf[referrer].length;
    }

    function resolveCode(bytes6 code) external view returns (address) {
        return codeToReferrer[code];
    }

    function authorizeMarket(address market) external onlyOwner {
        authorizedMarkets[market] = true;
    }
}
```

---

## contracts/src/FeeDistributor.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FeeDistributor
 * @notice Принимает 0.5% комиссии и распределяет:
 *         40% рефереры · 20% treasury · 20% liquidity mining · 20% NFT rewards
 */
contract FeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    address public treasury;
    address public liquidityPool;
    address public nftRewardsPool;

    // BPS из 10000
    uint256 public constant REF_BPS      = 4000; // 40%
    uint256 public constant TREASURY_BPS = 2000; // 20%
    uint256 public constant LP_BPS       = 2000; // 20%
    uint256 public constant NFT_BPS      = 2000; // 20%

    // Реферальные балансы (pull pattern)
    mapping(address => uint256) public referralBalance;

    event FeeReceived(address indexed market, uint256 amount);
    event ReferralCredited(address indexed referrer, uint256 amount);
    event ReferralClaimed(address indexed referrer, uint256 amount);

    constructor(
        address _usdc,
        address _treasury,
        address _liquidityPool,
        address _nftRewardsPool
    ) Ownable(msg.sender) {
        usdc           = IERC20(_usdc);
        treasury       = _treasury;
        liquidityPool  = _liquidityPool;
        nftRewardsPool = _nftRewardsPool;
    }

    /**
     * @notice Получить fee от рынка и распределить.
     * @param totalFee    Общая сумма комиссии
     * @param referrers   Массив адресов рефереров участников
     * @param betAmounts  Массив сумм ставок (для расчёта доли реферала)
     * @param totalPool   Общий пул для расчёта
     */
    function distributeFee(
        uint256 totalFee,
        address[] calldata referrers,
        uint256[] calldata betAmounts,
        uint256 totalPool
    ) external nonReentrant {
        require(referrers.length == betAmounts.length, "length mismatch");

        usdc.safeTransferFrom(msg.sender, address(this), totalFee);

        // Рассчитать реферальные выплаты
        // Каждый реферер получает 20% от fee своего реферала
        // fee реферала = (betAmount / totalPool) * totalFee * REF_BPS / 10000
        uint256 refPortion = totalFee * REF_BPS / 10_000;
        uint256 totalRefPaid = 0;

        for (uint256 i = 0; i < referrers.length; i++) {
            if (referrers[i] == address(0)) continue;
            // Реферер получает 20% от fee своего реферала
            uint256 refFee = (betAmounts[i] * totalFee / totalPool) * 20 / 100;
            referralBalance[referrers[i]] += refFee;
            totalRefPaid += refFee;
            emit ReferralCredited(referrers[i], refFee);
        }

        // Остаток распределить по протоколу
        uint256 remaining = totalFee - totalRefPaid;
        uint256 toTreasury = remaining * TREASURY_BPS / (TREASURY_BPS + LP_BPS + NFT_BPS);
        uint256 toLP       = remaining * LP_BPS       / (TREASURY_BPS + LP_BPS + NFT_BPS);
        uint256 toNFT      = remaining - toTreasury - toLP;

        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);
        if (toLP > 0)       usdc.safeTransfer(liquidityPool, toLP);
        if (toNFT > 0)      usdc.safeTransfer(nftRewardsPool, toNFT);

        emit FeeReceived(msg.sender, totalFee);
    }

    /**
     * @notice Реферер забирает накопленные USDC.
     */
    function claimReferralRewards() external nonReentrant {
        uint256 amount = referralBalance[msg.sender];
        require(amount > 0, "nothing to claim");
        referralBalance[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit ReferralClaimed(msg.sender, amount);
    }
}
```

---

## contracts/src/BadgeNFT.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title BadgeNFT
 * @notice Soulbound ERC-1155 бейджи. Нельзя передать, можно только минтить.
 *         Backend (MINTER_ROLE) минтит при выполнении условий.
 */
contract BadgeNFT is ERC1155, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public name   = "FlipTheMeme Badges";
    string public symbol = "MPBADGE";

    // badgeId → metadata
    struct BadgeInfo {
        string name;
        string rarity; // "common" | "rare" | "epic" | "legendary"
        bool exists;
    }
    mapping(uint256 => BadgeInfo) public badges;

    event BadgeEarned(address indexed trader, uint256 indexed badgeId, string badgeName);

    constructor(string memory baseURI) ERC1155(baseURI) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Зарегистрировать все бейджи
        _registerBadge(1,  "Начинающий",     "common");
        _registerBadge(2,  "На огне",         "common");
        _registerBadge(3,  "Алмазный",        "rare");
        _registerBadge(4,  "Снайпер",         "rare");
        _registerBadge(5,  "Скоростной",      "common");
        _registerBadge(6,  "Кит",             "rare");
        _registerBadge(7,  "К луне",          "epic");
        _registerBadge(8,  "Оракул",          "epic");
        _registerBadge(9,  "Легенда",         "legendary");
        _registerBadge(10, "Чемпион",         "legendary");
        _registerBadge(11, "Пеп-мастер",      "common");
        _registerBadge(12, "Бретт-фанат",     "common");
        _registerBadge(13, "Профи",           "rare");
        _registerBadge(14, "Институционал",   "epic");
        _registerBadge(15, "Коннектор",       "rare");
        _registerBadge(16, "Сеть",            "epic");
    }

    // ── SOULBOUND ──────────────────────────────────────────
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        // Разрешить только минт (from == 0) и сжигание (to == 0)
        require(from == address(0) || to == address(0), "Soulbound: non-transferable");
        super._update(from, to, ids, values);
    }

    // ── MINT ───────────────────────────────────────────────
    function mintBadge(address to, uint256 badgeId) external onlyRole(MINTER_ROLE) {
        require(badges[badgeId].exists, "badge not found");
        require(balanceOf(to, badgeId) == 0, "already has badge");

        _mint(to, badgeId, 1, "");
        emit BadgeEarned(to, badgeId, badges[badgeId].name);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function _registerBadge(uint256 id, string memory _name, string memory _rarity) internal {
        badges[id] = BadgeInfo({name: _name, rarity: _rarity, exists: true});
    }

    function addMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(MINTER_ROLE, minter);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return string(abi.encodePacked(super.uri(tokenId), tokenId.toString(), ".json"));
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
```

---

## contracts/test/PvPMarket.t.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PvPMarket.sol";
import "./mocks/MockUSDC.sol";

contract PvPMarketTest is Test {
    PvPMarket  market;
    MockUSDC   usdc;

    address resolver      = makeAddr("resolver");
    address feeDistrib    = makeAddr("feeDistrib");
    address multisig      = makeAddr("multisig");
    address alice         = makeAddr("alice");
    address bob           = makeAddr("bob");
    address referrer      = makeAddr("referrer");

    uint256 constant ENTRY_PRICE = 9142; // $0.000009142 * 1e6

    function setUp() public {
        usdc   = new MockUSDC();
        market = new PvPMarket(
            address(usdc), resolver, feeDistrib, multisig,
            15 minutes, bytes32("PEPE/USD"), ENTRY_PRICE
        );

        // Выдать USDC
        usdc.mint(alice, 1000e6);
        usdc.mint(bob,   1000e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);
    }

    // ── PLACE BET ──────────────────────────────────────────
    function test_PlaceBet_UP_Success() public {
        vm.prank(alice);
        market.placeBet(IMarket.Direction.UP, 50e6, referrer);

        assertEq(market.totalUpPool(), 50e6);
        assertEq(usdc.balanceOf(address(market)), 50e6);
    }

    function test_PlaceBet_Reverts_BelowMin() public {
        vm.prank(alice);
        vm.expectRevert("below min bet");
        market.placeBet(IMarket.Direction.UP, 0.5e6, address(0));
    }

    function test_PlaceBet_Reverts_AboveMax() public {
        vm.prank(alice);
        vm.expectRevert("above max bet");
        market.placeBet(IMarket.Direction.UP, 101e6, address(0));
    }

    function test_PlaceBet_Reverts_AfterClose() public {
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(alice);
        vm.expectRevert("market closed");
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
    }

    function test_PlaceBet_Reverts_DoubleBet() public {
        vm.startPrank(alice);
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.expectRevert("already bet UP");
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.stopPrank();
    }

    function test_PlaceBet_Reverts_SelfReferral() public {
        vm.prank(alice);
        vm.expectRevert("self referral");
        market.placeBet(IMarket.Direction.UP, 10e6, alice);
    }

    // ── SETTLE & CLAIM ─────────────────────────────────────
    function test_Settle_And_Claim_UpWon() public {
        // Alice: UP $60, Bob: DOWN $40
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice); market.claim();
        uint256 aliceAfter = usdc.balanceOf(alice);

        // Alice должна получить весь пул ($100) пропорционально её доле
        // FEE = 0%, Alice доля = 60/60 = 100% выигрышного пула
        // Её выплата = 60/60 * 100 = 100 USDC
        assertEq(aliceAfter - aliceBefore, 100e6);
    }

    function test_Settle_Reverts_LowLiquidity() public {
        // Только Alice ставит (нет противника)
        vm.prank(alice); market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        // Рынок должен стать REFUNDED
        assertEq(uint(market.status()), uint(IMarket.Status.REFUNDED));
    }

    function test_Claim_Reverts_AlreadyClaimed() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);
        vm.prank(alice); market.claim();
        vm.prank(alice);
        vm.expectRevert("already claimed");
        market.claim();
    }

    // ── EMERGENCY REFUND ───────────────────────────────────
    function test_EmergencyRefund_AfterGracePeriod() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP, 50e6, address(0));
        // Пропустить grace period без резолюции
        vm.warp(block.timestamp + 15 minutes + 1 hours + 1);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); market.emergencyRefund();
        assertEq(usdc.balanceOf(alice) - before, 50e6);
    }

    // ── FUZZ ───────────────────────────────────────────────
    function testFuzz_PlaceBet_AmountRange(uint256 amount) public {
        amount = bound(amount, 1e6, 100e6);
        vm.prank(alice);
        market.placeBet(IMarket.Direction.UP, amount, address(0));
        assertEq(market.totalUpPool(), amount);
    }

    function testFuzz_Settle_Payout(uint256 upAmount, uint256 downAmount) public {
        upAmount   = bound(upAmount,   100e6, 500e6);
        downAmount = bound(downAmount, 100e6, 500e6);

        usdc.mint(alice, upAmount);
        usdc.mint(bob,   downAmount);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   upAmount,   address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, downAmount, address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); market.claim();
        uint256 payout = usdc.balanceOf(alice) - before;

        // Alice должна получить >= её ставки (она выиграла)
        assertGe(payout, upAmount);
        // И <= общего пула (нельзя получить больше чем есть)
        assertLe(payout, upAmount + downAmount);
    }
}
```

---

## contracts/script/Deploy.s.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PvPMarket.sol";
import "../src/MarketFactory.sol";
import "../src/OracleResolver.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/BadgeNFT.sol";

contract Deploy is Script {
    // Base Mainnet addresses
    address constant USDC     = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PYTH     = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;

    // Pyth Feed IDs
    bytes32 constant FEED_PEPE  = 0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4;
    bytes32 constant FEED_DOGE  = 0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c;
    bytes32 constant FEED_BRETT = bytes32(0); // TODO: добавить после листинга
    bytes32 constant FEED_TOSHI = bytes32(0); // TODO: добавить после листинга

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address multisig    = vm.envAddress("MULTISIG_ADDRESS");
        address treasury    = vm.envAddress("TREASURY_ADDRESS");
        address keeper      = vm.envAddress("KEEPER_ADDRESS");

        vm.startBroadcast(deployerKey);

        // 1. FeeDistributor
        FeeDistributor feeDistrib = new FeeDistributor(
            USDC, treasury, treasury, treasury // TODO: отдельные адреса
        );
        console.log("FeeDistributor:", address(feeDistrib));

        // 2. ReferralRegistry
        ReferralRegistry referralReg = new ReferralRegistry();
        console.log("ReferralRegistry:", address(referralReg));

        // 3. OracleResolver
        OracleResolver oracleResolver = new OracleResolver(PYTH);
        oracleResolver.addKeeper(keeper);
        console.log("OracleResolver:", address(oracleResolver));

        // 4. MarketFactory
        MarketFactory factory = new MarketFactory(
            USDC,
            address(oracleResolver),
            address(feeDistrib),
            multisig
        );
        // Добавить монеты
        factory.addFeed(FEED_PEPE);
        factory.addFeed(FEED_DOGE);
        console.log("MarketFactory:", address(factory));

        // 5. BadgeNFT
        BadgeNFT badges = new BadgeNFT("ipfs://YOUR_IPFS_HASH/");
        console.log("BadgeNFT:", address(badges));

        vm.stopBroadcast();

        // Вывести в .env формате
        console.log("\n--- Copy to .env ---");
        console.log("FEE_DISTRIBUTOR=%s",    address(feeDistrib));
        console.log("REFERRAL_REGISTRY=%s",  address(referralReg));
        console.log("ORACLE_RESOLVER=%s",    address(oracleResolver));
        console.log("MARKET_FACTORY=%s",     address(factory));
        console.log("BADGE_NFT=%s",          address(badges));
    }
}
```

---

---

# ЧАСТЬ 2: BACKEND API

---

## Структура backend/

```
backend/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # ENV, constants
│   ├── db/
│   │   ├── pg.ts             # PostgreSQL client
│   │   ├── redis.ts          # Redis client
│   │   └── migrations/
│   │       └── 001_init.sql
│   ├── routes/
│   │   ├── markets.ts
│   │   ├── candles.ts
│   │   ├── leaderboard.ts
│   │   ├── profile.ts
│   │   └── referral.ts
│   ├── services/
│   │   ├── candleService.ts  # OHLC агрегация из Pyth
│   │   ├── badgeService.ts   # Логика выдачи бейджей
│   │   ├── streakService.ts  # Streak расчёт
│   │   └── graphService.ts   # The Graph запросы
│   ├── keeper/
│   │   ├── index.ts          # Keeper entry
│   │   ├── priceRecorder.ts  # Запись цен каждые 30 сек
│   │   ├── marketCreator.ts  # Создание рынков по расписанию
│   │   └── resolver.ts       # Резолюция закрытых рынков
│   └── types/
│       └── index.ts
```

---

## backend/src/index.ts

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { marketsRoutes }     from './routes/markets'
import { candlesRoutes }     from './routes/candles'
import { leaderboardRoutes } from './routes/leaderboard'
import { profileRoutes }     from './routes/profile'
import { referralRoutes }    from './routes/referral'
import { pg }    from './db/pg'
import { redis } from './db/redis'

const app = Fastify({ logger: true })

// ── PLUGINS ────────────────────────────────────────────────
await app.register(cors, {
  origin: [
    'https://flipthememe.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ]
})

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
})

// ── ROUTES ─────────────────────────────────────────────────
await app.register(marketsRoutes,     { prefix: '/api/markets' })
await app.register(candlesRoutes,     { prefix: '/api/candles' })
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
await app.register(profileRoutes,     { prefix: '/api/profile' })
await app.register(referralRoutes,    { prefix: '/api/referral' })

// ── HEALTH ─────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

// ── START ──────────────────────────────────────────────────
try {
  await pg.connect()
  await redis.connect()
  await app.listen({ port: Number(process.env.PORT || 3001), host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
```

---

## backend/src/routes/candles.ts

```typescript
import { FastifyInstance } from 'fastify'
import { redis } from '../db/redis'
import { pg }    from '../db/pg'

interface CandlesQuery {
  tf?: '5m' | '15m' | '1h' | '4h' | '1d'
  limit?: number
}

export async function candlesRoutes(app: FastifyInstance) {

  /**
   * GET /api/candles/:feedId?tf=5m&limit=100
   * Возвращает OHLC свечи для монеты
   */
  app.get<{ Params: { feedId: string }; Querystring: CandlesQuery }>(
    '/:feedId',
    async (req, reply) => {
      const { feedId } = req.params
      const tf    = req.query.tf    || '5m'
      const limit = Math.min(req.query.limit || 100, 500)

      const cacheKey = `candles:${feedId}:${tf}:${limit}`
      const cached   = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const intervalMap: Record<string, string> = {
        '5m':  '5 minutes',
        '15m': '15 minutes',
        '1h':  '1 hour',
        '4h':  '4 hours',
        '1d':  '1 day'
      }

      const interval = intervalMap[tf]

      // PostgreSQL time_bucket для агрегации в свечи
      const result = await pg.query(`
        SELECT
          time_bucket($1, recorded_at) AS time,
          FIRST(price, recorded_at)    AS open,
          MAX(price)                   AS high,
          MIN(price)                   AS low,
          LAST(price, recorded_at)     AS close,
          COUNT(*)                     AS ticks
        FROM price_history
        WHERE feed_id = $2
          AND recorded_at > NOW() - INTERVAL '7 days'
        GROUP BY time
        ORDER BY time DESC
        LIMIT $3
      `, [interval, feedId, limit])

      const candles = result.rows.reverse().map(r => ({
        time:  Math.floor(new Date(r.time).getTime() / 1000),
        open:  parseFloat(r.open),
        high:  parseFloat(r.high),
        low:   parseFloat(r.low),
        close: parseFloat(r.close)
      }))

      await redis.setEx(cacheKey, 30, JSON.stringify(candles))
      return candles
    }
  )

  /**
   * GET /api/candles/:marketAddress/prob-history
   * История вероятности UP% для конкретного рынка
   */
  app.get<{ Params: { marketAddress: string } }>(
    '/:marketAddress/prob-history',
    async (req, reply) => {
      const { marketAddress } = req.params
      const cacheKey = `prob:${marketAddress}`
      const cached   = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const result = await pg.query(`
        SELECT
          snapshot_at,
          up_pool,
          down_pool,
          CASE WHEN (up_pool + down_pool) = 0 THEN 50
               ELSE ROUND(up_pool * 100.0 / (up_pool + down_pool), 1)
          END AS up_pct
        FROM prob_snapshots
        WHERE market_address = $1
        ORDER BY snapshot_at ASC
      `, [marketAddress])

      const history = result.rows.map(r => ({
        ts:     Math.floor(new Date(r.snapshot_at).getTime() / 1000),
        upPct:  parseFloat(r.up_pct),
        upPool: parseFloat(r.up_pool),
        dnPool: parseFloat(r.down_pool)
      }))

      await redis.setEx(cacheKey, 10, JSON.stringify(history))
      return history
    }
  )
}
```

---

## backend/src/routes/referral.ts

```typescript
import { FastifyInstance } from 'fastify'
import { pg }    from '../db/pg'
import { redis } from '../db/redis'

export async function referralRoutes(app: FastifyInstance) {

  /**
   * GET /api/referral/:address
   * Статистика реферера
   */
  app.get<{ Params: { address: string } }>(
    '/:address',
    async (req) => {
      const addr = req.params.address.toLowerCase()

      const result = await pg.query(`
        SELECT
          COUNT(*)                        AS referral_count,
          COALESCE(SUM(r.bet_volume), 0)  AS total_volume,
          COALESCE(SUM(r.earned_usdc), 0) AS total_earned
        FROM referrals r
        WHERE r.referrer_address = $1
      `, [addr])

      const claimable = await pg.query(`
        SELECT COALESCE(SUM(amount), 0) AS claimable
        FROM referral_earnings
        WHERE referrer_address = $1 AND claimed = false
      `, [addr])

      return {
        referralCount: parseInt(result.rows[0].referral_count),
        totalVolume:   parseFloat(result.rows[0].total_volume),
        totalEarned:   parseFloat(result.rows[0].total_earned),
        claimable:     parseFloat(claimable.rows[0].claimable)
      }
    }
  )

  /**
   * GET /api/referral/resolve/:code
   * Конвертировать реф-код в адрес реферера
   */
  app.get<{ Params: { code: string } }>(
    '/resolve/:code',
    async (req, reply) => {
      const cacheKey = `refcode:${req.params.code}`
      const cached   = await redis.get(cacheKey)
      if (cached) return { referrer: cached }

      const result = await pg.query(
        'SELECT referrer_address FROM ref_codes WHERE code = $1',
        [req.params.code]
      )

      if (!result.rows[0]) return reply.code(404).send({ error: 'code not found' })

      const referrer = result.rows[0].referrer_address
      await redis.setEx(cacheKey, 3600, referrer)
      return { referrer }
    }
  )

  /**
   * GET /api/referral/list/:address
   * Список рефералов с их статистикой
   */
  app.get<{ Params: { address: string } }>(
    '/list/:address',
    async (req) => {
      const result = await pg.query(`
        SELECT
          r.referee_address,
          r.registered_at,
          COALESCE(SUM(b.amount_usdc), 0) AS volume,
          COALESCE(
            SUM(b.amount_usdc * 0.005 * 0.20), 0
          ) AS earned
        FROM referrals r
        LEFT JOIN bets b ON b.trader_address = r.referee_address
        WHERE r.referrer_address = $1
        GROUP BY r.referee_address, r.registered_at
        ORDER BY volume DESC
        LIMIT 50
      `, [req.params.address.toLowerCase()])

      return result.rows
    }
  )
}
```

---

## backend/src/routes/leaderboard.ts

```typescript
import { FastifyInstance } from 'fastify'
import { redis } from '../db/redis'
import { pg }    from '../db/pg'

export async function leaderboardRoutes(app: FastifyInstance) {

  /**
   * GET /api/leaderboard?period=weekly&limit=100
   */
  app.get<{ Querystring: { period?: string; limit?: number } }>(
    '/',
    async (req) => {
      const period = req.query.period || 'weekly'
      const limit  = Math.min(req.query.limit || 100, 200)

      const cacheKey = `leaderboard:${period}:${limit}`
      const cached   = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const intervals: Record<string, string> = {
        weekly:  '7 days',
        monthly: '30 days',
        alltime: '100 years'
      }
      const interval = intervals[period] || '7 days'

      const result = await pg.query(`
        SELECT
          trader_address,
          COUNT(*)                                          AS total_bets,
          COUNT(*) FILTER (WHERE won = true)               AS won_bets,
          ROUND(
            COUNT(*) FILTER (WHERE won = true)::numeric
            / NULLIF(COUNT(*), 0) * 100, 1
          )                                                AS accuracy_pct,
          COALESCE(SUM(amount_usdc), 0)                    AS total_volume,
          COALESCE(SUM(CASE WHEN won THEN payout_usdc - amount_usdc
                            ELSE -amount_usdc END), 0)     AS profit,
          MAX(current_streak)                              AS streak
        FROM bets
        WHERE settled_at > NOW() - INTERVAL '${interval}'
        GROUP BY trader_address
        HAVING COUNT(*) >= 5
        ORDER BY accuracy_pct DESC, total_volume DESC
        LIMIT $1
      `, [limit])

      const board = result.rows.map((r, i) => ({
        rank:        i + 1,
        address:     r.trader_address,
        totalBets:   parseInt(r.total_bets),
        wonBets:     parseInt(r.won_bets),
        accuracy:    parseFloat(r.accuracy_pct),
        volume:      parseFloat(r.total_volume),
        profit:      parseFloat(r.profit),
        streak:      parseInt(r.streak)
      }))

      await redis.setEx(cacheKey, 60, JSON.stringify(board))
      return board
    }
  )
}
```

---

## backend/src/keeper/priceRecorder.ts

```typescript
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { pg } from '../db/pg'
import { ORACLE_RESOLVER_ABI, ORACLE_RESOLVER_ADDRESS } from '../config'

const PYTH_HERMES = 'https://hermes.pyth.network'

const FEED_IDS = {
  PEPE:  '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4',
  DOGE:  '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
  BRETT: '0x...', // TODO
  TOSHI: '0x...', // TODO
}

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL!) })

/**
 * Запись цен каждые 30 секунд.
 * Запускается в keeper/index.ts через setInterval.
 */
export async function recordAllPrices() {
  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      // Получить priceUpdateData от Pyth Hermes
      const hermesUrl = `${PYTH_HERMES}/api/latest_price_feeds?ids[]=${feedId}&binary=true`
      const hermes    = await fetch(hermesUrl)
      const data      = await hermes.json()

      if (!data[0]) continue

      const price   = parseInt(data[0].price.price)
      const expo    = data[0].price.expo
      // Нормализовать к float
      const priceUsd = price * Math.pow(10, expo)

      // Записать в БД
      await pg.query(
        'INSERT INTO price_history (feed_id, symbol, price, recorded_at) VALUES ($1, $2, $3, NOW())',
        [feedId, symbol, priceUsd]
      )

      // Опционально: вызвать on-chain recordPrice (дороже, но нужно для TWAP контракта)
      // await callOnChainRecord(feedId, data[0].binary)

    } catch (err) {
      console.error(`Failed to record price for ${symbol}:`, err)
    }
  }
}

/**
 * Снапшот вероятности для открытых рынков каждую минуту.
 */
export async function snapshotProbabilities() {
  const openMarkets = await pg.query(
    "SELECT market_address, up_pool, down_pool FROM markets WHERE status = 'OPEN'"
  )

  for (const row of openMarkets.rows) {
    await pg.query(
      'INSERT INTO prob_snapshots (market_address, up_pool, down_pool, snapshot_at) VALUES ($1, $2, $3, NOW())',
      [row.market_address, row.up_pool, row.down_pool]
    )
  }
}
```

---

## backend/src/services/badgeService.ts

```typescript
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { pg }   from '../db/pg'
import { BADGE_NFT_ABI, BADGE_NFT_ADDRESS } from '../config'

const account = privateKeyToAccount(process.env.BADGE_MINTER_KEY as `0x${string}`)
const client  = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL!) })

interface TraderStats {
  address:      string
  totalBets:    number
  wonBets:      number
  currentStreak:number
  maxStreak:    number
  totalVolume:  number
  pепeBets:     number
  brettBets:    number
}

// Условия для каждого бейджа
const BADGE_CONDITIONS: Record<number, (s: TraderStats) => boolean> = {
  1:  s => s.totalBets >= 1,                              // Начинающий
  2:  s => s.currentStreak >= 7,                          // На огне
  3:  s => s.currentStreak >= 30,                         // Алмазный
  4:  s => false, // TODO: 10 верных подряд               // Снайпер
  5:  s => false, // TODO: первый на 5М рынке             // Скоростной
  6:  s => s.totalVolume >= 500,                          // Кит
  7:  s => false, // TODO: угадал движение 10%+           // К луне
  8:  s => s.totalBets >= 100 && s.wonBets / s.totalBets >= 0.80, // Оракул
  9:  s => s.currentStreak >= 100,                        // Легенда
  10: s => false, // TODO: топ-1 за неделю                // Чемпион
  11: s => s.pепeBets >= 50,                              // Пеп-мастер
  12: s => s.brettBets >= 50,                             // Бретт-фанат
  13: s => s.totalVolume >= 10_000,                       // Профи
  14: s => s.totalVolume >= 100_000,                      // Институционал
  15: s => false, // TODO: 5 активных рефералов           // Коннектор
  16: s => false, // TODO: 20 активных рефералов          // Сеть
}

/**
 * Проверить и выдать бейджи для трейдера.
 * Запускается после каждого settle события.
 */
export async function checkAndMintBadges(traderAddress: string) {
  const stats = await getTraderStats(traderAddress)

  for (const [badgeIdStr, condition] of Object.entries(BADGE_CONDITIONS)) {
    const badgeId = parseInt(badgeIdStr)
    if (!condition(stats)) continue

    // Проверить что бейдж ещё не выдан (off-chain кэш)
    const existing = await pg.query(
      'SELECT 1 FROM minted_badges WHERE trader_address = $1 AND badge_id = $2',
      [traderAddress, badgeId]
    )
    if (existing.rows.length > 0) continue

    try {
      // Минт on-chain
      const hash = await client.writeContract({
        address: BADGE_NFT_ADDRESS,
        abi:     BADGE_NFT_ABI,
        functionName: 'mintBadge',
        args: [traderAddress as `0x${string}`, BigInt(badgeId)]
      })

      // Записать в БД
      await pg.query(
        'INSERT INTO minted_badges (trader_address, badge_id, tx_hash, minted_at) VALUES ($1, $2, $3, NOW())',
        [traderAddress, badgeId, hash]
      )

      console.log(`Minted badge ${badgeId} for ${traderAddress}, tx: ${hash}`)
    } catch (err) {
      console.error(`Failed to mint badge ${badgeId} for ${traderAddress}:`, err)
    }
  }
}

async function getTraderStats(address: string): Promise<TraderStats> {
  const result = await pg.query(`
    SELECT
      COUNT(*)                                           AS total_bets,
      COUNT(*) FILTER (WHERE won = true)                AS won_bets,
      COALESCE(SUM(amount_usdc), 0)                     AS total_volume,
      COUNT(*) FILTER (WHERE feed_symbol = 'PEPE')      AS pepe_bets,
      COUNT(*) FILTER (WHERE feed_symbol = 'BRETT')     AS brett_bets
    FROM bets
    WHERE trader_address = $1 AND settled_at IS NOT NULL
  `, [address.toLowerCase()])

  const streak = await pg.query(
    'SELECT current_streak, max_streak FROM trader_streaks WHERE trader_address = $1',
    [address.toLowerCase()]
  )

  const r = result.rows[0]
  const s = streak.rows[0] || { current_streak: 0, max_streak: 0 }

  return {
    address,
    totalBets:     parseInt(r.total_bets),
    wonBets:       parseInt(r.won_bets),
    currentStreak: parseInt(s.current_streak),
    maxStreak:     parseInt(s.max_streak),
    totalVolume:   parseFloat(r.total_volume),
    pепeBets:      parseInt(r.pepe_bets),
    brettBets:     parseInt(r.brett_bets)
  }
}
```

---

## backend/db/migrations/001_init.sql

```sql
-- Расширения
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Цены монет (TimescaleDB hypertable для быстрых запросов)
CREATE TABLE price_history (
  id          BIGSERIAL,
  feed_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  price       NUMERIC(30, 18) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('price_history', 'recorded_at');
CREATE INDEX ON price_history (feed_id, recorded_at DESC);

-- Рынки (синхронизируется из The Graph)
CREATE TABLE markets (
  market_address TEXT PRIMARY KEY,
  feed_id        TEXT NOT NULL,
  feed_symbol    TEXT NOT NULL,
  duration_secs  INTEGER NOT NULL,
  open_time      TIMESTAMPTZ NOT NULL,
  close_time     TIMESTAMPTZ NOT NULL,
  entry_price    NUMERIC(30, 18),
  exit_price     NUMERIC(30, 18),
  status         TEXT NOT NULL DEFAULT 'OPEN',
  up_won         BOOLEAN,
  up_pool        NUMERIC(20, 6) DEFAULT 0,
  down_pool      NUMERIC(20, 6) DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Ставки
CREATE TABLE bets (
  id              BIGSERIAL PRIMARY KEY,
  market_address  TEXT NOT NULL REFERENCES markets(market_address),
  trader_address  TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  amount_usdc     NUMERIC(20, 6) NOT NULL,
  referrer_address TEXT,
  won             BOOLEAN,
  payout_usdc     NUMERIC(20, 6),
  claimed         BOOLEAN DEFAULT FALSE,
  placed_at       TIMESTAMPTZ NOT NULL,
  settled_at      TIMESTAMPTZ,
  feed_symbol     TEXT NOT NULL
);
CREATE INDEX ON bets (trader_address, settled_at DESC);
CREATE INDEX ON bets (market_address);

-- Рефералы
CREATE TABLE referrals (
  referrer_address TEXT NOT NULL,
  referee_address  TEXT NOT NULL UNIQUE,
  registered_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (referrer_address, referee_address)
);

CREATE TABLE ref_codes (
  code             TEXT PRIMARY KEY,
  referrer_address TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE referral_earnings (
  id               BIGSERIAL PRIMARY KEY,
  referrer_address TEXT NOT NULL,
  referee_address  TEXT NOT NULL,
  market_address   TEXT NOT NULL,
  amount           NUMERIC(20, 6) NOT NULL,
  claimed          BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Снапшоты вероятности
CREATE TABLE prob_snapshots (
  id             BIGSERIAL,
  market_address TEXT NOT NULL,
  up_pool        NUMERIC(20, 6) DEFAULT 0,
  down_pool      NUMERIC(20, 6) DEFAULT 0,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('prob_snapshots', 'snapshot_at');

-- Стрики
CREATE TABLE trader_streaks (
  trader_address TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  max_streak     INTEGER DEFAULT 0,
  last_bet_date  DATE,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- NFT бейджи
CREATE TABLE minted_badges (
  trader_address TEXT NOT NULL,
  badge_id       INTEGER NOT NULL,
  tx_hash        TEXT,
  minted_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trader_address, badge_id)
);
```

---

---

# ЧАСТЬ 3: FRONTEND

---

## Структура frontend/

```
frontend/
├── package.json
├── vite.config.ts
├── .env.example
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── wagmi.config.ts
│   ├── pages/
│   │   ├── Markets.tsx
│   │   ├── Market.tsx        # Детальная + графики
│   │   ├── Portfolio.tsx
│   │   ├── Leaderboard.tsx
│   │   └── Refer.tsx
│   ├── components/
│   │   ├── MarketCard.tsx
│   │   ├── BetForm.tsx
│   │   ├── MarketChart.tsx   # Canvas графики
│   │   ├── ProbBar.tsx
│   │   ├── ShareCard.tsx
│   │   ├── BadgeGrid.tsx
│   │   └── GeoBlock.tsx
│   ├── hooks/
│   │   ├── useMarkets.ts
│   │   ├── usePlaceBet.ts
│   │   ├── useClaim.ts
│   │   ├── useOdds.ts
│   │   ├── useCandles.ts
│   │   └── useReferral.ts
│   ├── lib/
│   │   ├── contracts.ts
│   │   ├── pyth.ts
│   │   └── geocheck.ts
│   └── store/
│       └── useAppStore.ts
```

---

## frontend/src/wagmi.config.ts

```typescript
import { createConfig, http } from 'wagmi'
import { base, baseSepolia }  from 'wagmi/chains'
import { coinbaseWallet, metaMask, injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [
    import.meta.env.VITE_NETWORK === 'mainnet' ? base : baseSepolia
  ],
  connectors: [
    coinbaseWallet({
      appName: 'FlipTheMeme',
      appLogoUrl: 'https://flipthememe.com/logo.png',
      preference: 'smartWalletOnly' // Coinbase Smart Wallet
    }),
    metaMask(),
    injected()
  ],
  transports: {
    [base.id]:        http(import.meta.env.VITE_BASE_RPC_URL),
    [baseSepolia.id]: http('https://sepolia.base.org')
  }
})
```

---

## frontend/src/lib/contracts.ts

```typescript
import { type Address } from 'viem'

// ── ADDRESSES ──────────────────────────────────────────────
export const CONTRACTS = {
  USDC:              import.meta.env.VITE_USDC_ADDRESS             as Address,
  MARKET_FACTORY:    import.meta.env.VITE_MARKET_FACTORY           as Address,
  ORACLE_RESOLVER:   import.meta.env.VITE_ORACLE_RESOLVER          as Address,
  FEE_DISTRIBUTOR:   import.meta.env.VITE_FEE_DISTRIBUTOR          as Address,
  REFERRAL_REGISTRY: import.meta.env.VITE_REFERRAL_REGISTRY        as Address,
  BADGE_NFT:         import.meta.env.VITE_BADGE_NFT                as Address,
} as const

// ── ABI (сокращённые, полные генерировать через forge) ─────
export const PVPMARKET_ABI = [
  {
    name: 'placeBet',
    type: 'function',
    inputs: [
      { name: 'dir',      type: 'uint8'   },
      { name: 'amount',   type: 'uint256' },
      { name: 'referrer', type: 'address' }
    ],
    outputs: []
  },
  {
    name: 'claim',
    type: 'function',
    inputs: [],
    outputs: []
  },
  {
    name: 'emergencyRefund',
    type: 'function',
    inputs: [],
    outputs: []
  },
  {
    name: 'totalUpPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'totalDownPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'getOdds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'upOdds',   type: 'uint256' },
      { name: 'downOdds', type: 'uint256' }
    ]
  },
  {
    name: 'status',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }]
  },
  {
    name: 'marketCloseTime',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  // Events
  {
    name: 'BetPlaced',
    type: 'event',
    inputs: [
      { name: 'trader',    type: 'address', indexed: true  },
      { name: 'direction', type: 'uint8',   indexed: false },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'referrer',  type: 'address', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'MarketSettled',
    type: 'event',
    inputs: [
      { name: 'upWon',          type: 'bool',    indexed: false },
      { name: 'entryPrice',     type: 'uint256', indexed: false },
      { name: 'exitPrice',      type: 'uint256', indexed: false },
      { name: 'totalUpPool',    type: 'uint256', indexed: false },
      { name: 'totalDownPool',  type: 'uint256', indexed: false }
    ]
  }
] as const

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const
```

---

## frontend/src/hooks/usePlaceBet.ts

```typescript
import { useState, useCallback } from 'react'
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount
} from 'wagmi'
import { parseUnits, maxUint256, type Address } from 'viem'
import { CONTRACTS, PVPMARKET_ABI, ERC20_ABI } from '../lib/contracts'

export type Direction = 0 | 1  // 0=UP, 1=DOWN

interface UsePlaceBetArgs {
  marketAddress: Address
  direction:     Direction
  amountUsd:     string      // строка, например "25.00"
  referrer?:     Address
}

type BetStep = 'idle' | 'approving' | 'approved' | 'betting' | 'confirmed' | 'error'

export function usePlaceBet({
  marketAddress,
  direction,
  amountUsd,
  referrer = '0x0000000000000000000000000000000000000000'
}: UsePlaceBetArgs) {

  const { address } = useAccount()
  const [step, setStep] = useState<BetStep>('idle')
  const [error, setError] = useState<string>()

  const amountWei = parseUnits(amountUsd || '0', 6) // USDC = 6 decimals

  // ── CHECK ALLOWANCE ──────────────────────────────────────
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi:     ERC20_ABI,
    functionName: 'allowance',
    args: [address!, marketAddress],
    query: { enabled: !!address }
  })

  // ── APPROVE ──────────────────────────────────────────────
  const { writeContractAsync: approve, data: approveTxHash } = useWriteContract()

  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: !!approveTxHash }
  })

  // ── PLACE BET ────────────────────────────────────────────
  const { writeContractAsync: placeBet, data: betTxHash } = useWriteContract()

  const { isSuccess: betConfirmed } = useWaitForTransactionReceipt({
    hash: betTxHash,
    query: { enabled: !!betTxHash }
  })

  // ── EXECUTE ──────────────────────────────────────────────
  const execute = useCallback(async () => {
    if (!address || amountWei === 0n) return
    setError(undefined)

    try {
      // 1. Approve если нужно
      if (!allowance || allowance < amountWei) {
        setStep('approving')
        await approve({
          address: CONTRACTS.USDC,
          abi:     ERC20_ABI,
          functionName: 'approve',
          args: [marketAddress, maxUint256]
        })
        await refetchAllowance()
      }

      // 2. Place bet
      setStep('betting')
      await placeBet({
        address:      marketAddress,
        abi:          PVPMARKET_ABI,
        functionName: 'placeBet',
        args: [direction, amountWei, referrer]
      })

      setStep('confirmed')
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage || err?.message || 'Transaction failed')
    }
  }, [address, amountWei, allowance, direction, marketAddress, referrer])

  return {
    execute,
    step,
    error,
    betTxHash,
    isLoading:   step === 'approving' || step === 'betting',
    isConfirmed: step === 'confirmed'
  }
}
```

---

## frontend/src/hooks/useCandles.ts

```typescript
import { useQuery } from '@tanstack/react-query'

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'

export interface Candle {
  time:  number  // unix timestamp
  open:  number
  high:  number
  low:   number
  close: number
}

export interface ProbPoint {
  ts:     number
  upPct:  number
  upPool: number
  dnPool: number
}

const API = import.meta.env.VITE_API_URL

export function useCandles(feedId: string, tf: Timeframe = '5m') {
  return useQuery<Candle[]>({
    queryKey: ['candles', feedId, tf],
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${feedId}?tf=${tf}&limit=100`)
      if (!res.ok) throw new Error('Failed to fetch candles')
      return res.json()
    },
    refetchInterval: 30_000,  // каждые 30 сек
    staleTime:       20_000
  })
}

export function useProbHistory(marketAddress: string) {
  return useQuery<ProbPoint[]>({
    queryKey: ['prob-history', marketAddress],
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${marketAddress}/prob-history`)
      if (!res.ok) throw new Error('Failed to fetch prob history')
      return res.json()
    },
    refetchInterval: 15_000,
    staleTime:       10_000
  })
}
```

---

## frontend/src/components/MarketChart.tsx

```typescript
import { useRef, useEffect, useState } from 'react'
import { useCandles, useProbHistory, type Candle, type Timeframe } from '../hooks/useCandles'

interface Props {
  feedId:        string
  marketAddress: string
}

type ChartMode = 'price' | 'prob' | 'volume'

export function MarketChart({ feedId, marketAddress }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<ChartMode>('price')
  const [tf,   setTf]   = useState<Timeframe>('5m')

  const { data: candles    } = useCandles(feedId, tf)
  const { data: probHistory } = useProbHistory(marketAddress)

  // ── DRAW ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    canvas.width  = W * window.devicePixelRatio
    canvas.height = H * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    ctx.clearRect(0, 0, W, H)

    if (mode === 'price' && candles?.length)       drawCandles(ctx, candles, W, H)
    if (mode === 'prob'  && probHistory?.length)   drawProbHistory(ctx, probHistory, W, H)

  }, [candles, probHistory, mode, tf])

  // ── CANDLE RENDERER ───────────────────────────────────────
  function drawCandles(ctx: CanvasRenderingContext2D, data: Candle[], W: number, H: number) {
    const pad  = { t: 20, b: 30, l: 4, r: 60 }
    const prices = data.flatMap(c => [c.high, c.low])
    const minP   = Math.min(...prices)
    const maxP   = Math.max(...prices)
    const range  = maxP - minP || 1
    const cw     = (W - pad.l - pad.r) / data.length

    const toY = (p: number) => pad.t + (1 - (p - minP) / range) * (H - pad.t - pad.b)

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth   = 1
    for (let i = 0; i <= 4; i++) {
      const y   = pad.t + (i / 4) * (H - pad.t - pad.b)
      const val = maxP - (i / 4) * range
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke()
      ctx.fillStyle  = 'rgba(255,255,255,0.25)'
      ctx.font       = '9px JetBrains Mono'
      ctx.textAlign  = 'left'
      ctx.fillText(val < 0.0001 ? val.toExponential(2) : val.toPrecision(4), W - pad.r + 4, y + 3)
    }

    // Candles
    data.forEach((c, i) => {
      const x    = pad.l + i * cw + cw / 2
      const bw   = Math.max(cw * 0.65, 2)
      const bull = c.close >= c.open
      const col  = bull ? '#00ff88' : '#ff3355'

      ctx.strokeStyle = col
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(x, toY(c.high)); ctx.lineTo(x, toY(c.low))
      ctx.stroke()

      const y1 = toY(Math.max(c.open, c.close))
      const y2 = toY(Math.min(c.open, c.close))
      ctx.fillStyle = bull ? 'rgba(0,255,136,0.85)' : 'rgba(255,51,85,0.85)'
      ctx.fillRect(x - bw / 2, y1, bw, Math.max(y2 - y1, 1))
    })

    // Last price dashed line
    const last = data[data.length - 1]
    ctx.strokeStyle = 'rgba(255,221,0,0.5)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(pad.l, toY(last.close))
    ctx.lineTo(W - pad.r, toY(last.close))
    ctx.stroke()
    ctx.setLineDash([])
  }

  // ── PROB RENDERER ─────────────────────────────────────────
  function drawProbHistory(ctx: CanvasRenderingContext2D, data: any[], W: number, H: number) {
    const pad = { t: 20, b: 28, l: 4, r: 40 }
    const n   = data.length
    if (n < 2) return

    const toX = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r)
    const toY = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b)

    // 50% reference line
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])
    const y50 = toY(50)
    ctx.beginPath(); ctx.moveTo(pad.l, y50); ctx.lineTo(W - pad.r, y50); ctx.stroke()
    ctx.setLineDash([])

    // UP fill (green area above line)
    ctx.beginPath()
    ctx.moveTo(toX(0), pad.t)
    data.forEach((d, i) => ctx.lineTo(toX(i), toY(d.upPct)))
    ctx.lineTo(toX(n-1), pad.t)
    ctx.closePath()
    const gUp = ctx.createLinearGradient(0, pad.t, 0, H - pad.b)
    gUp.addColorStop(0, 'rgba(0,255,136,0.3)')
    gUp.addColorStop(1, 'rgba(0,255,136,0.02)')
    ctx.fillStyle = gUp
    ctx.fill()

    // DOWN fill (red area below line)
    ctx.beginPath()
    ctx.moveTo(toX(0), H - pad.b)
    data.forEach((d, i) => ctx.lineTo(toX(i), toY(d.upPct)))
    ctx.lineTo(toX(n-1), H - pad.b)
    ctx.closePath()
    const gDn = ctx.createLinearGradient(0, pad.t, 0, H - pad.b)
    gDn.addColorStop(0, 'rgba(255,51,85,0.02)')
    gDn.addColorStop(1, 'rgba(255,51,85,0.25)')
    ctx.fillStyle = gDn
    ctx.fill()

    // UP line
    ctx.beginPath()
    data.forEach((d, i) => {
      i === 0 ? ctx.moveTo(toX(i), toY(d.upPct)) : ctx.lineTo(toX(i), toY(d.upPct))
    })
    ctx.strokeStyle = '#00ff88'
    ctx.lineWidth   = 2
    ctx.stroke()

    // Y labels
    ;[0, 25, 50, 75, 100].forEach(v => {
      ctx.fillStyle = 'rgba(255,255,255,0.2)'
      ctx.font      = '9px JetBrains Mono'
      ctx.textAlign = 'left'
      ctx.fillText(`${v}%`, W - pad.r + 4, toY(v) + 3)
    })
  }

  // ── RENDER ────────────────────────────────────────────────
  return (
    <div style={{ background: '#111', borderBottom: '1px solid #2a2a2a' }}>
      {/* Mode tabs */}
      <div style={{ display: 'flex', padding: '0 14px', borderBottom: '1px solid #2a2a2a' }}>
        {(['price', 'prob', 'volume'] as ChartMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '7px 12px',
              fontFamily: 'JetBrains Mono',
              fontSize: 10,
              fontWeight: 700,
              color: mode === m ? '#00ff88' : '#555',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${mode === m ? '#00ff88' : 'transparent'}`,
              cursor: 'pointer',
              letterSpacing: '.04em',
              textTransform: 'uppercase'
            }}
          >
            {m === 'price' ? 'ЦЕНА' : m === 'prob' ? 'ВЕРОЯТНОСТЬ' : 'ОБЪЁМ'}
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div style={{ height: 180, padding: '8px 8px 4px', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>

      {/* TF selector */}
      <div style={{ display: 'flex', gap: 4, padding: '4px 14px 8px' }}>
        {(['5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map(t => (
          <button
            key={t}
            onClick={() => setTf(t)}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              fontFamily: 'JetBrains Mono',
              fontSize: 9,
              fontWeight: 700,
              color: tf === t ? '#00ff88' : '#555',
              background: tf === t ? 'rgba(0,255,136,0.1)' : 'transparent',
              border: `1px solid ${tf === t ? 'rgba(0,255,136,0.3)' : '#2a2a2a'}`,
              cursor: 'pointer'
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
```

---

## frontend/src/lib/geocheck.ts

```typescript
const BLOCKED_COUNTRIES = ['US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG']

export async function checkGeo(): Promise<{ blocked: boolean; country: string }> {
  try {
    // Cloudflare даёт geo info через заголовки — читаем через наш API
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/geo`)
    const { country } = await res.json()
    return {
      blocked: BLOCKED_COUNTRIES.includes(country),
      country
    }
  } catch {
    return { blocked: false, country: 'XX' }
  }
}
```

---

---

# ЧАСТЬ 4: CLOUDFLARE WORKERS

---

## workers/geo-block.ts

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const country = (request as any).cf?.country as string | undefined

    const BLOCKED = ['US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG']

    if (country && BLOCKED.includes(country)) {
      return new Response(
        JSON.stringify({
          error:   'region_blocked',
          message: 'FlipTheMeme is not available in your region.',
          country
        }),
        {
          status:  451, // Unavailable For Legal Reasons
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    // Добавить geo заголовок для backend
    const modReq = new Request(request)
    // @ts-ignore
    modReq.headers.set('X-Country', country || 'XX')

    return fetch(modReq)
  }
}

interface Env {}
```

---

---

# ЧАСТЬ 5: THE GRAPH SUBGRAPH

---

## subgraph/schema.graphql

```graphql
type Market @entity {
  id:            ID!          # market address
  feedId:        Bytes!
  feedSymbol:    String!
  duration:      BigInt!
  openTime:      BigInt!
  closeTime:     BigInt!
  entryPrice:    BigInt
  exitPrice:     BigInt
  status:        String!      # OPEN | CLOSED | RESOLVED | REFUNDED
  upWon:         Boolean
  totalUpPool:   BigInt!
  totalDownPool: BigInt!
  bets:          [Bet!]! @derivedFrom(field: "market")
  createdAt:     BigInt!
}

type Bet @entity {
  id:        ID!              # txHash-logIndex
  market:    Market!
  trader:    Bytes!
  direction: String!          # UP | DOWN
  amount:    BigInt!
  referrer:  Bytes
  claimed:   Boolean!
  won:       Boolean
  payout:    BigInt
  placedAt:  BigInt!
  settledAt: BigInt
}

type Trader @entity {
  id:            ID!          # address
  totalBets:     BigInt!
  wonBets:       BigInt!
  totalVolume:   BigInt!
  totalProfit:   BigInt!
  currentStreak: BigInt!
  maxStreak:     BigInt!
  lastBetDay:    BigInt       # unix day
  referralCount: BigInt!
  referralEarnings: BigInt!
  badges:        [Int!]!
}

type Referral @entity {
  id:           ID!           # referee address
  referrer:     Bytes!
  referee:      Bytes!
  registeredAt: BigInt!
}
```

---

---

# ЧАСТЬ 6: ENV / CONFIG

---

## .env.example (корень проекта)

```bash
# ── CONTRACTS ──────────────────────────────────────────────
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PYTH_ADDRESS=0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a
MARKET_FACTORY=0x...
ORACLE_RESOLVER=0x...
FEE_DISTRIBUTOR=0x...
REFERRAL_REGISTRY=0x...
BADGE_NFT=0x...

# ── KEYS ───────────────────────────────────────────────────
PRIVATE_KEY=0x...                # Deployer
MULTISIG_ADDRESS=0x...           # Multisig 3/5
TREASURY_ADDRESS=0x...
KEEPER_ADDRESS=0x...             # Keeper hot wallet
BADGE_MINTER_KEY=0x...           # Backend minter

# ── RPC ────────────────────────────────────────────────────
BASE_RPC_URL=https://mainnet.base.org
BASESCAN_API_KEY=...

# ── BACKEND ────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@localhost:5432/flipthememe
REDIS_URL=redis://localhost:6379
PORT=3001

# ── FRONTEND (VITE_) ───────────────────────────────────────
VITE_NETWORK=mainnet
VITE_BASE_RPC_URL=https://mainnet.base.org
VITE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
VITE_MARKET_FACTORY=0x...
VITE_ORACLE_RESOLVER=0x...
VITE_FEE_DISTRIBUTOR=0x...
VITE_REFERRAL_REGISTRY=0x...
VITE_BADGE_NFT=0x...
VITE_API_URL=https://api.flipthememe.com
VITE_GRAPH_URL=https://api.thegraph.com/subgraphs/name/flipthememe/base

# ── EXTERNAL ───────────────────────────────────────────────
PYTH_HERMES_URL=https://hermes.pyth.network
PINATA_API_KEY=...
DISCORD_BOT_TOKEN=...
TWITTER_BEARER_TOKEN=...
```

---

---

# ЧАСТЬ 7: ЧЕКЛИСТ ПЕРЕД MAINNET

```
КОНТРАКТЫ
[ ] forge test --coverage покрытие >95%
[ ] forge test --fuzz-runs 10000 прошли
[ ] Деплой на Base Sepolia, тест 2 недели
[ ] Внешний аудит (Code4rena или Certik)
[ ] Все critical/high findings закрыты
[ ] Multisig 3/5 настроен
[ ] Timelock 48ч на upgrade функции
[ ] MAX_BET = 100 USDC установлен
[ ] MIN_POOL_SIDE = 100 USDC установлен
[ ] Emergency pause протестирован
[ ] Bug bounty на Immunefi ($50K max)

ИНФРА
[ ] Гео-блок Cloudflare Worker задеплоен
[ ] Тест гео-блока через VPN (US → заблокирован)
[ ] Keeper работает стабильно 48ч подряд
[ ] Tenderly alerts настроены
[ ] База данных TimescaleDB настроена
[ ] Redis кэш работает
[ ] The Graph subgraph индексирует события

FRONTEND
[ ] Мобильный тест на iOS Safari + Android Chrome
[ ] Coinbase Wallet подключение работает
[ ] MetaMask подключение работает
[ ] USDC approve + placeBet флоу работает
[ ] Claim выигрыша работает
[ ] Графики рендерятся на мобильном
[ ] GeoBlock экран показывается в заблокированных регионах

МАРКЕТИНГ ($500-2K)
[ ] $800 seed liquidity в первые рынки
[ ] 1 KOL твит ($500) в день запуска
[ ] Discord сервер готов, бот настроен
[ ] Farcaster аккаунт создан
[ ] OG meta-теги для шаринга позиций
[ ] Terms of Service опубликован

ПОСЛЕ АУДИТА
[ ] MAX_BET снять
[ ] FEE_BPS = 50 (0.5%) включить
[ ] Лимит рынка $10K → $100K
```

---

*FlipTheMeme v3.0 · Финальное ТЗ с кодом · Март 2026*
*Base chain · PvP · USDC · Pump.fun UX · Non-custodial*
