# MemePred — Дополнение к ТЗ
# Модуль: Решение холодного старта
# Добавить к memepred-final-tz.md

---

## КОНТЕКСТ ДЛЯ AI-АССИСТЕНТА

Дополнение к основному ТЗ. Заменяет простую PvP механику на
трёхслойный матчинг. Всё остальное (OracleResolver, BadgeNFT,
Frontend роуты, Backend API) остаётся без изменений.

---

## Проблема и решение

Если пользователь один → нет противника → возврат → плохой UX.

Три слоя матчинга, каждый следующий включается если предыдущий не сработал:

```
Ставка пользователя
        │
        ▼
┌───────────────────────────────┐
│  СЛОЙ 1: Ордербук             │  ищем PvP противника 60 сек
│  pendingUp[] ↔ pendingDown[]  │  лучший UX, нет риска
└──────────────┬────────────────┘
               │ не нашли
               ▼
┌───────────────────────────────┐
│  СЛОЙ 2: Genesis LP пул       │  пул матчит автоматически
│  LiquidityPool.sol            │  макс 10% депозита LP на ставку
└──────────────┬────────────────┘
               │ пул пуст
               ▼
┌───────────────────────────────┐
│  СЛОЙ 3: Очередь 5 мин        │  уведомление юзеру
│  "ждём противника"            │  потом автоматический refund
└───────────────────────────────┘
```

---

## Новые файлы контрактов

```
contracts/src/
├── OrderbookMarket.sol   # заменяет PvPMarket.sol
├── LiquidityPool.sol     # Genesis LP пул
└── GenesisNFT.sol        # NFT для ранних LP
```

---

## contracts/src/OrderbookMarket.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title OrderbookMarket
 * @notice Rolling рынок с асинхронным матчингом.
 *
 * Жизненный цикл ставки:
 *   placeBet() → PENDING → match() → MATCHED → settle() → SETTLED → claim()
 *
 * Каждый матч имеет свою entryPrice — цена фиксируется
 * в момент матча, не в момент создания рынка.
 * Это позволяет матчить ставки в любое время.
 */
contract OrderbookMarket is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── TYPES ──────────────────────────────────────────────
    enum Direction   { UP, DOWN }
    enum OrderStatus { PENDING, MATCHED, SETTLED, CLAIMED, REFUNDED }

    struct Order {
        address     trader;
        Direction   direction;
        uint256     amount;
        address     referrer;
        OrderStatus status;
        uint256     placedAt;
        uint256     matchId;    // 0 если не заматчен
    }

    struct Match {
        uint256 upOrderId;
        uint256 downOrderId;
        uint256 amount;       // min(upOrder.amount, downOrder.amount)
        uint256 entryPrice;   // цена в момент матча
        uint256 settleAt;     // placedAt + duration
        uint256 exitPrice;    // заполняется при резолюции
        bool    settled;
        bool    upWon;
        bool    lpMatch;      // true если матч с LP пулом
    }

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant MIN_BET       = 1e6;       // 1 USDC
    uint256 public constant MAX_BET       = 100e6;     // 100 USDC, снять после аудита
    uint256 public constant MATCH_TIMEOUT = 5 minutes; // макс ожидание → refund
    uint256 public constant FEE_BPS       = 0;         // 0% на старте, потом 50

    // ── IMMUTABLES ─────────────────────────────────────────
    IERC20  public immutable usdc;
    address public immutable resolver;
    address public immutable liquidityPool;
    address public immutable feeDistributor;
    address public immutable multisig;
    bytes32 public immutable pythFeedId;
    uint256 public immutable duration;

    // ── STATE ──────────────────────────────────────────────
    uint256 public nextOrderId = 1;
    uint256 public nextMatchId = 1;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => Match) public matches;

    // Очереди ожидания
    uint256[] public pendingUpQueue;
    uint256[] public pendingDownQueue;

    // trader → его orderIds
    mapping(address => uint256[]) public traderOrders;

    // ── EVENTS ─────────────────────────────────────────────
    event OrderPlaced  (uint256 indexed orderId, address trader, Direction dir, uint256 amount);
    event OrderMatched (uint256 indexed matchId, uint256 upId, uint256 downId, uint256 entryPrice);
    event LPMatched    (uint256 indexed matchId, uint256 orderId, uint256 entryPrice);
    event MatchSettled (uint256 indexed matchId, bool upWon, uint256 entry, uint256 exit);
    event OrderRefunded(uint256 indexed orderId, address trader, uint256 amount);
    event Claimed      (uint256 indexed orderId, address trader, uint256 payout);

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(
        address _usdc,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _multisig,
        bytes32 _pythFeedId,
        uint256 _duration
    ) {
        usdc          = IERC20(_usdc);
        resolver      = _resolver;
        liquidityPool = _liquidityPool;
        feeDistributor = _feeDistributor;
        multisig      = _multisig;
        pythFeedId    = _pythFeedId;
        duration      = _duration;
    }

    // ── PLACE BET ──────────────────────────────────────────
    /**
     * @notice Разместить ставку.
     *         Сразу пробует PvP матч → LP матч → очередь.
     */
    function placeBet(
        Direction dir,
        uint256   amount,
        address   referrer,
        uint256   currentPrice  // передаётся с frontend из Pyth
    ) external nonReentrant whenNotPaused returns (uint256 orderId) {
        require(amount >= MIN_BET,        "below min");
        require(amount <= MAX_BET,        "above max");
        require(referrer != msg.sender,   "self referral");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        orderId = nextOrderId++;
        orders[orderId] = Order({
            trader:    msg.sender,
            direction: dir,
            amount:    amount,
            referrer:  referrer,
            status:    OrderStatus.PENDING,
            placedAt:  block.timestamp,
            matchId:   0
        });
        traderOrders[msg.sender].push(orderId);

        emit OrderPlaced(orderId, msg.sender, dir, amount);

        // Пробуем матч немедленно
        _tryMatch(orderId, dir, amount, currentPrice);
    }

    // ── MATCHING LOGIC ─────────────────────────────────────
    /**
     * @notice Попытка матча: сначала ордербук, потом LP.
     */
    function _tryMatch(
        uint256   orderId,
        Direction dir,
        uint256   amount,
        uint256   currentPrice
    ) internal {
        // Слой 1: ищем PvP противника в очереди
        uint256[] storage oppositeQueue = dir == Direction.UP
            ? pendingDownQueue
            : pendingUpQueue;

        for (uint256 i = 0; i < oppositeQueue.length; i++) {
            uint256 candidateId = oppositeQueue[i];
            Order storage candidate = orders[candidateId];

            // Пропустить устаревшие или уже заматченные
            if (candidate.status != OrderStatus.PENDING) continue;
            if (block.timestamp - candidate.placedAt > MATCH_TIMEOUT) continue;

            // Матч! Берём минимальную сумму
            uint256 matchAmount = amount < candidate.amount ? amount : candidate.amount;
            _createMatch(orderId, candidateId, dir, matchAmount, currentPrice, false);

            // Удалить из очереди
            _removeFromQueue(oppositeQueue, i);
            return;
        }

        // Слой 2: пробуем LP пул
        bool lpMatched = ILiquidityPool(liquidityPool).tryMatch(
            orderId, amount, dir, currentPrice
        );
        if (lpMatched) return;

        // Слой 3: добавить в очередь ожидания
        if (dir == Direction.UP) {
            pendingUpQueue.push(orderId);
        } else {
            pendingDownQueue.push(orderId);
        }
    }

    function _createMatch(
        uint256   orderId,
        uint256   oppositeId,
        Direction dir,
        uint256   amount,
        uint256   entryPrice,
        bool      isLpMatch
    ) internal {
        uint256 matchId = nextMatchId++;

        uint256 upId   = dir == Direction.UP ? orderId   : oppositeId;
        uint256 downId = dir == Direction.UP ? oppositeId : orderId;

        matches[matchId] = Match({
            upOrderId:   upId,
            downOrderId: downId,
            amount:      amount,
            entryPrice:  entryPrice,
            settleAt:    block.timestamp + duration,
            exitPrice:   0,
            settled:     false,
            upWon:       false,
            lpMatch:     isLpMatch
        });

        orders[orderId].status  = OrderStatus.MATCHED;
        orders[orderId].matchId = matchId;

        if (!isLpMatch) {
            orders[oppositeId].status  = OrderStatus.MATCHED;
            orders[oppositeId].matchId = matchId;
            emit OrderMatched(matchId, upId, downId, entryPrice);
        } else {
            emit LPMatched(matchId, orderId, entryPrice);
        }
    }

    // ── SETTLE ─────────────────────────────────────────────
    /**
     * @notice Вызывается OracleResolver после истечения duration.
     */
    function settleMatch(
        uint256 matchId,
        uint256 exitPrice
    ) external {
        require(msg.sender == resolver, "only resolver");
        Match storage m = matches[matchId];
        require(!m.settled,               "already settled");
        require(block.timestamp >= m.settleAt, "too early");

        m.settled   = true;
        m.exitPrice = exitPrice;
        m.upWon     = exitPrice > m.entryPrice;

        // Обновить статус ордеров
        _settleOrder(m.upOrderId,   m.upWon,  m);
        if (!m.lpMatch) {
            _settleOrder(m.downOrderId, !m.upWon, m);
        } else {
            // Уведомить LP пул о результате
            ILiquidityPool(liquidityPool).onMatchSettled(matchId, m.upWon);
        }

        emit MatchSettled(matchId, m.upWon, m.entryPrice, exitPrice);
    }

    function _settleOrder(
        uint256 orderId,
        bool    won,
        Match storage m
    ) internal {
        Order storage o = orders[orderId];
        o.status = OrderStatus.SETTLED;

        if (won) {
            uint256 totalPool = m.amount * 2;
            uint256 fee       = (totalPool * FEE_BPS) / 10_000;
            o.payout = totalPool - fee;
            // TODO: отправить fee в feeDistributor
        }
    }

    // ── CLAIM ──────────────────────────────────────────────
    function claim(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.trader == msg.sender,          "not your order");
        require(o.status == OrderStatus.SETTLED, "not settled");
        require(o.payout > 0,                    "nothing to claim");

        o.status = OrderStatus.CLAIMED;
        usdc.safeTransfer(msg.sender, o.payout);

        emit Claimed(orderId, msg.sender, o.payout);
    }

    // ── REFUND EXPIRED ─────────────────────────────────────
    /**
     * @notice Вернуть ставки которые не заматчились за MATCH_TIMEOUT.
     *         Вызывает keeper или сам пользователь.
     */
    function refundExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PENDING,                   "not pending");
        require(block.timestamp > o.placedAt + MATCH_TIMEOUT,     "not expired");

        o.status = OrderStatus.REFUNDED;
        usdc.safeTransfer(o.trader, o.amount);

        emit OrderRefunded(orderId, o.trader, o.amount);
    }

    // ── HELPERS ────────────────────────────────────────────
    function _removeFromQueue(uint256[] storage queue, uint256 index) internal {
        queue[index] = queue[queue.length - 1];
        queue.pop();
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getPendingDepth() external view returns (uint256 up, uint256 down) {
        return (pendingUpQueue.length, pendingDownQueue.length);
    }

    function getTraderOrders(address trader) external view returns (uint256[] memory) {
        return traderOrders[trader];
    }

    // ── ADMIN ──────────────────────────────────────────────
    function pause()   external { require(msg.sender == multisig); _pause();   }
    function unpause() external { require(msg.sender == multisig); _unpause(); }
}

interface ILiquidityPool {
    function tryMatch(uint256 orderId, uint256 amount, OrderbookMarket.Direction dir, uint256 price) external returns (bool);
    function onMatchSettled(uint256 matchId, bool upWon) external;
}
```

---

## contracts/src/LiquidityPool.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./GenesisNFT.sol";

/**
 * @title LiquidityPool
 * @notice Genesis LP пул — страховка от пустого ордербука.
 *
 * Провайдеры депонируют USDC. Пул автоматически матчит
 * незаматченные ставки. LP берут на себя Direction риск
 * в обмен на повышенную долю комиссий.
 *
 * Защита LP: макс 10% депозита на одну ставку (LP_MAX_EXPOSURE).
 * Если ставка больше — LP матчит частично, остаток в очередь.
 *
 * Genesis провайдеры (первые 20): получают GenesisNFT
 * и повышенную долю комиссий навсегда (80% вместо 50%).
 */
contract LiquidityPool is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ── TYPES ──────────────────────────────────────────────
    struct Provider {
        uint256 deposit;      // текущий депозит USDC
        uint256 exposure;     // текущий риск (сумма незарезолвленных матчей)
        uint256 totalEarned;  // всего заработано комиссий
        bool    isGenesis;    // Genesis провайдер?
        uint256 joinedAt;
    }

    struct ActiveMatch {
        uint256 orderId;
        uint256 amount;
        bool    lpIsDown;    // LP занял DOWN позицию (пользователь UP)
        bool    settled;
    }

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant LP_MAX_EXPOSURE  = 1000; // 10% от депозита BPS
    uint256 public constant MIN_DEPOSIT      = 50e6; // 50 USDC минимум
    uint256 public constant GENESIS_MAX      = 20;   // первые 20 провайдеров
    uint256 public constant GENESIS_FEE_SHARE = 8000; // 80% от комиссий
    uint256 public constant NORMAL_FEE_SHARE  = 5000; // 50% от комиссий

    // ── IMMUTABLES ─────────────────────────────────────────
    IERC20     public immutable usdc;
    GenesisNFT public immutable genesisNFT;
    address    public immutable market;   // OrderbookMarket

    // ── STATE ──────────────────────────────────────────────
    mapping(address => Provider)     public providers;
    mapping(uint256 => ActiveMatch)  public activeMatches; // matchId → match

    address[] public providerList;
    uint256   public genesisCount;
    uint256   public totalDeposited;

    // Накопленные комиссии для LP (pull pattern)
    mapping(address => uint256) public pendingFees;

    // ── EVENTS ─────────────────────────────────────────────
    event Deposited    (address indexed lp, uint256 amount, bool isGenesis);
    event Withdrawn    (address indexed lp, uint256 amount);
    event MatchTaken   (uint256 indexed matchId, uint256 orderId, uint256 amount);
    event FeesClaimed  (address indexed lp, uint256 amount);

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(address _usdc, address _genesisNFT, address _market) Ownable(msg.sender) {
        usdc       = IERC20(_usdc);
        genesisNFT = GenesisNFT(_genesisNFT);
        market     = _market;
    }

    // ── DEPOSIT ────────────────────────────────────────────
    /**
     * @notice Стать провайдером ликвидности.
     *         Первые 20 получают GenesisNFT и повышенные комиссии навсегда.
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount >= MIN_DEPOSIT, "below min deposit");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        bool isNew = providers[msg.sender].deposit == 0;

        if (isNew) {
            providerList.push(msg.sender);
            providers[msg.sender].joinedAt = block.timestamp;
        }

        providers[msg.sender].deposit += amount;
        totalDeposited += amount;

        // Genesis статус — первые 20 уникальных провайдеров
        if (isNew && genesisCount < GENESIS_MAX) {
            providers[msg.sender].isGenesis = true;
            genesisCount++;
            genesisNFT.mint(msg.sender, genesisCount); // tokenId = порядковый номер
        }

        emit Deposited(msg.sender, amount, providers[msg.sender].isGenesis);
    }

    // ── WITHDRAW ───────────────────────────────────────────
    /**
     * @notice Вывести депозит. Нельзя вывести заэкспозиченную часть.
     */
    function withdraw(uint256 amount) external nonReentrant {
        Provider storage p = providers[msg.sender];
        uint256 available  = p.deposit > p.exposure ? p.deposit - p.exposure : 0;
        require(amount <= available, "amount locked in active matches");

        p.deposit      -= amount;
        totalDeposited -= amount;
        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ── TRY MATCH (вызывается из OrderbookMarket) ──────────
    /**
     * @notice Попытка матча с LP пулом.
     * @return matched  true если пул взял ставку
     */
    function tryMatch(
        uint256 orderId,
        uint256 amount,
        bool    userIsUp,  // Direction.UP = true
        uint256 entryPrice
    ) external returns (bool matched) {
        require(msg.sender == market, "only market");

        // Считаем доступную ликвидность пула
        uint256 available = _availableLiquidity();
        if (available == 0) return false;

        // LP матчит не более доступного
        uint256 matchAmount = amount <= available ? amount : available;

        // Заморозить ликвидность у всех провайдеров пропорционально
        _lockExposure(matchAmount);

        // Записать активный матч
        uint256 matchId = IOrderbookMarket(market).currentMatchId() + 1;
        activeMatches[matchId] = ActiveMatch({
            orderId:  orderId,
            amount:   matchAmount,
            lpIsDown: userIsUp, // если юзер UP — LP занимает DOWN
            settled:  false
        });

        emit MatchTaken(matchId, orderId, matchAmount);
        return true;
    }

    // ── ON SETTLE (вызывается из OrderbookMarket) ──────────
    /**
     * @notice Колбэк после резолюции матча с LP.
     *         Если LP проиграл — списываем из депозита.
     *         Если LP выиграл — добавляем в депозит + комиссии.
     */
    function onMatchSettled(uint256 matchId, bool upWon) external {
        require(msg.sender == market, "only market");

        ActiveMatch storage am = activeMatches[matchId];
        require(!am.settled, "already settled");
        am.settled = true;

        bool lpWon = am.lpIsDown ? !upWon : upWon;

        if (lpWon) {
            // LP выиграл: +amount в пул (забираем ставку проигравшего юзера)
            totalDeposited += am.amount;
            // Распределить комиссии по провайдерам
            _distributeFees(am.amount / 100); // 1% от выигрыша как fee
        } else {
            // LP проиграл: -amount из пула (выплачиваем юзеру)
            totalDeposited = totalDeposited > am.amount ? totalDeposited - am.amount : 0;
        }

        _unlockExposure(am.amount);
    }

    // ── CLAIM FEES ─────────────────────────────────────────
    function claimFees() external nonReentrant {
        uint256 amount = pendingFees[msg.sender];
        require(amount > 0, "no fees");
        pendingFees[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }

    // ── INTERNAL ───────────────────────────────────────────
    function _availableLiquidity() internal view returns (uint256) {
        if (totalDeposited == 0) return 0;

        // Суммируем доступную ликвидность каждого провайдера
        // (депозит - текущий риск, но не более 10% депозита на ставку)
        uint256 total = 0;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 maxExp = p.deposit * LP_MAX_EXPOSURE / 10_000;
            if (p.exposure < maxExp) {
                total += maxExp - p.exposure;
            }
        }
        return total;
    }

    function _lockExposure(uint256 amount) internal {
        // Блокируем пропорционально у каждого провайдера
        if (totalDeposited == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 share = amount * p.deposit / totalDeposited;
            p.exposure += share;
        }
    }

    function _unlockExposure(uint256 amount) internal {
        if (totalDeposited == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 share = amount * p.deposit / totalDeposited;
            p.exposure = p.exposure > share ? p.exposure - share : 0;
        }
    }

    function _distributeFees(uint256 totalFee) internal {
        if (totalDeposited == 0 || totalFee == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            address lp  = providerList[i];
            Provider storage p = providers[lp];
            uint256 share     = totalFee * p.deposit / totalDeposited;
            // Genesis получают 80%, остальные 50%
            uint256 lpFee = p.isGenesis
                ? share * GENESIS_FEE_SHARE / 10_000
                : share * NORMAL_FEE_SHARE  / 10_000;
            pendingFees[lp] += lpFee;
            p.totalEarned   += lpFee;
        }
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getPoolStats() external view returns (
        uint256 total,
        uint256 available,
        uint256 providerCount,
        uint256 genesisLeft
    ) {
        return (
            totalDeposited,
            _availableLiquidity(),
            providerList.length,
            GENESIS_MAX - genesisCount
        );
    }

    function getProvider(address lp) external view returns (Provider memory) {
        return providers[lp];
    }
}

interface IOrderbookMarket {
    function currentMatchId() external view returns (uint256);
}
```

---

## contracts/src/GenesisNFT.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GenesisNFT
 * @notice ERC-721 для первых 20 LP провайдеров.
 *         Tradeable (в отличие от soulbound BadgeNFT).
 *         Даёт повышенные комиссии тому кто держит токен.
 *         Продал токен → продал право на повышенные комиссии.
 */
contract GenesisNFT is ERC721, Ownable {

    uint256 public constant MAX_SUPPLY = 20;
    uint256 public totalMinted;

    // tokenId → номер в порядке (1–20)
    mapping(uint256 => uint256) public genesisNumber;

    string public baseURI;

    // Только LiquidityPool может минтить
    address public liquidityPool;

    event GenesisMinted(address indexed to, uint256 tokenId, uint256 number);

    constructor(string memory _baseURI) ERC721("MemePred Genesis", "MPGEN") Ownable(msg.sender) {
        baseURI = _baseURI;
    }

    function mint(address to, uint256 number) external {
        require(msg.sender == liquidityPool, "only pool");
        require(totalMinted < MAX_SUPPLY,    "max supply");

        uint256 tokenId = ++totalMinted;
        genesisNumber[tokenId] = number;
        _mint(to, tokenId);

        emit GenesisMinted(to, tokenId, number);
    }

    function setLiquidityPool(address _pool) external onlyOwner {
        liquidityPool = _pool;
    }

    function setBaseURI(string memory _uri) external onlyOwner {
        baseURI = _uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return string(abi.encodePacked(baseURI, Strings.toString(tokenId), ".json"));
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }
}
```

---

## Genesis LP программа — маркетинг

### Что получают первые 20 LP

| # | Привилегия | Навсегда? |
|---|-----------|-----------|
| GenesisNFT #1–20 | Tradeable ERC-721, нельзя купить после запуска | ✅ |
| 80% от комиссий | Стандарт 50%, Genesis 80% | ✅ пока держат NFT |
| Hall of Fame | Адрес на сайте навсегда | ✅ |
| Governance vote | Приоритетный голос за новые монеты | ✅ |

**Важно:** привилегия привязана к NFT, не к адресу.
Продал NFT → новый владелец получает 80%.
Это делает Genesis NFT финансовым активом с реальной ценностью.

### Как анонсировать (Farcaster / Twitter)

```
🎴 MemePred Genesis LP — 20 мест

Первые 20 провайдеров ликвидности получают:
→ GenesisNFT #1–20 (навсегда уникальный)
→ 80% от комиссий протокола (vs 50% у остальных)
→ Минимум: 50 USDC

Старт: [дата]
memepred.xyz/genesis
```

---

## Frontend — новые компоненты

### src/pages/Genesis.tsx (новая страница)

```typescript
import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { parseUnits } from 'viem'
import { CONTRACTS, LIQUIDITY_POOL_ABI } from '../lib/contracts'

export function GenesisPage() {
  const { address } = useAccount()

  // Статистика пула
  const { data: stats } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'getPoolStats',
    // Возвращает: { total, available, providerCount, genesisLeft }
  })

  const { writeContractAsync: deposit } = useWriteContract()

  async function handleDeposit(amountUsd: string) {
    const amount = parseUnits(amountUsd, 6)

    // Сначала approve
    await approveUSDC(amount)

    await deposit({
      address:      CONTRACTS.LIQUIDITY_POOL,
      abi:          LIQUIDITY_POOL_ABI,
      functionName: 'deposit',
      args:         [amount]
    })
  }

  return (
    <div>
      {/* Счётчик оставшихся Genesis мест */}
      <div>Осталось Genesis мест: {stats?.genesisLeft?.toString() ?? '...'} / 20</div>

      {/* Статистика пула */}
      <div>Всего в пуле: ${Number(stats?.total ?? 0n) / 1e6}</div>
      <div>Доступно: ${Number(stats?.available ?? 0n) / 1e6}</div>

      {/* Кнопка депозита */}
      <button onClick={() => handleDeposit('50')}>
        Стать Genesis LP · $50 USDC
      </button>
    </div>
  )
}
```

### Изменения в хуке usePlaceBet.ts

```typescript
// Добавить в существующий usePlaceBet.ts:

// Новый аргумент — текущая цена из Pyth (нужна для entryPrice)
interface UsePlaceBetArgs {
  marketAddress: Address
  direction:     Direction
  amountUsd:     string
  referrer?:     Address
  currentPrice:  bigint   // ← НОВОЕ: цена из Pyth в момент ставки
}

// В функции execute() изменить вызов:
await placeBet({
  address:      marketAddress,
  abi:          ORDERBOOK_MARKET_ABI,
  functionName: 'placeBet',
  args: [direction, amountWei, referrer, currentPrice]  // ← добавлен currentPrice
})
```

### Новый хук useOrderStatus.ts

```typescript
import { useReadContract, useWatchContractEvent } from 'wagmi'
import { useState, useEffect } from 'react'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import type { Address } from 'viem'

/**
 * Следит за статусом ставки в реальном времени.
 * Показывает пользователю: ищем матч → заматчен → результат
 */
export function useOrderStatus(marketAddress: Address, orderId: bigint) {
  const [status, setStatus] = useState<
    'pending' | 'matched' | 'settled' | 'claimed' | 'refunded'
  >('pending')

  const [matchedAt, setMatchedAt] = useState<number>()
  const [settleAt,  setSettleAt]  = useState<number>()
  const [payout,    setPayout]    = useState<bigint>()

  // Читаем ордер из контракта
  const { data: order, refetch } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'orders',
    args:         [orderId]
  })

  // Слушаем события матча
  useWatchContractEvent({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    eventName:    'OrderMatched',
    onLogs: (logs) => {
      for (const log of logs) {
        const { upOrderId, downOrderId } = log.args as any
        if (upOrderId === orderId || downOrderId === orderId) {
          setStatus('matched')
          refetch()
        }
      }
    }
  })

  useWatchContractEvent({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    eventName:    'LPMatched',
    onLogs: (logs) => {
      for (const log of logs) {
        if ((log.args as any).orderId === orderId) {
          setStatus('matched')
          refetch()
        }
      }
    }
  })

  // Таймер до refund если pending
  const [secondsLeft, setSecondsLeft] = useState(300) // 5 мин

  useEffect(() => {
    if (status !== 'pending') return
    const interval = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [status])

  return {
    status,
    secondsLeft,   // до авто-refund если pending
    matchedAt,
    settleAt,
    payout,
    refetch
  }
}
```

---

## UI — что видит пользователь после ставки

```
// Статус 1: ищем матч
┌─────────────────────────────────┐
│ 🔍 Ищем противника...           │
│ PEPE ▲ UP · $25.00             │
│ ████████░░░░░░░░  04:32 осталось│
│ Возврат если не найдём          │
└─────────────────────────────────┘

// Статус 2: заматчен с игроком
┌─────────────────────────────────┐
│ ⚡ Заматчен!                    │
│ PEPE ▲ UP · $25.00             │
│ Вход: $0.00000914               │
│ Результат через 14:58           │
└─────────────────────────────────┘

// Статус 3: заматчен с LP пулом
┌─────────────────────────────────┐
│ 🏦 Заматчен с пулом             │
│ PEPE ▲ UP · $25.00             │
│ Вход: $0.00000914               │
│ Результат через 14:58           │
└─────────────────────────────────┘

// Статус 4: выиграл
┌─────────────────────────────────┐
│ 🎉 Выиграл!                     │
│ PEPE вырос: +3.2%               │
│ Выплата: $48.50                 │
│ [Забрать $48.50]                │
└─────────────────────────────────┘
```

---

## Тесты — добавить в test/

```solidity
// contracts/test/OrderbookMarket.t.sol

function test_Match_PvP_Success() public {
    // Alice ставит UP
    vm.prank(alice);
    uint256 aliceOrderId = market.placeBet(Direction.UP, 25e6, address(0), ENTRY_PRICE);

    // Bob ставит DOWN — должен заматчиться с Alice
    vm.prank(bob);
    uint256 bobOrderId = market.placeBet(Direction.DOWN, 25e6, address(0), ENTRY_PRICE);

    assertEq(uint(market.orders(aliceOrderId).status), uint(OrderStatus.MATCHED));
    assertEq(uint(market.orders(bobOrderId).status),   uint(OrderStatus.MATCHED));
}

function test_Match_LP_Fallback() public {
    // Пул пополнен
    vm.prank(lpProvider);
    pool.deposit(500e6);

    // Alice ставит UP — нет PvP противника → LP матчит
    vm.prank(alice);
    uint256 orderId = market.placeBet(Direction.UP, 25e6, address(0), ENTRY_PRICE);

    assertEq(uint(market.orders(orderId).status), uint(OrderStatus.MATCHED));
}

function test_Refund_If_No_Match() public {
    // Alice ставит UP — нет противника, нет LP
    vm.prank(alice);
    uint256 orderId = market.placeBet(Direction.UP, 25e6, address(0), ENTRY_PRICE);

    // Прошло 5 минут
    vm.warp(block.timestamp + 5 minutes + 1);

    uint256 before = usdc.balanceOf(alice);
    vm.prank(alice);
    market.refundExpired(orderId);

    assertEq(usdc.balanceOf(alice) - before, 25e6);
}

function test_Genesis_NFT_Minted_For_First_20() public {
    for (uint i = 0; i < 20; i++) {
        address lp = makeAddr(string(abi.encodePacked("lp", i)));
        usdc.mint(lp, 50e6);
        vm.prank(lp);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp);
        pool.deposit(50e6);
        assertEq(genesisNFT.balanceOf(lp), 1);
    }
    // 21-й не получает NFT
    address lp21 = makeAddr("lp21");
    usdc.mint(lp21, 50e6);
    vm.prank(lp21); usdc.approve(address(pool), type(uint256).max);
    vm.prank(lp21); pool.deposit(50e6);
    assertEq(genesisNFT.balanceOf(lp21), 0);
}

function test_Genesis_Gets_Higher_Fee_Share() public {
    // Genesis LP vs обычный LP — разные доли комиссий
    // TODO: проверить pendingFees после settled матча
}
```

---

## Чеклист изменений в основном ТЗ

```
КОНТРАКТЫ
[ ] PvPMarket.sol → заменить на OrderbookMarket.sol
[ ] Добавить LiquidityPool.sol
[ ] Добавить GenesisNFT.sol
[ ] MarketFactory.sol → деплоить OrderbookMarket вместо PvPMarket
[ ] Keeper: добавить задачу refundExpired() каждые 5 мин

FRONTEND
[ ] Добавить страницу /genesis
[ ] usePlaceBet.ts → добавить currentPrice аргумент
[ ] Добавить хук useOrderStatus.ts
[ ] Добавить UI статусов ставки (pending / matched / settled)
[ ] Показывать глубину очереди (сколько ждут UP / DOWN)

BACKEND
[ ] Новый endpoint GET /api/pool/stats
[ ] Webhook при Genesis NFT минте → Discord анонс
[ ] Трекинг: сколько ставок заматчено через LP vs PvP
```

---

*MemePred · Дополнение к ТЗ · Холодный старт · Март 2026*
