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
 *         Деплоится MarketFactory через EIP-1167 minimal proxy.
 *         Использует initialize() вместо constructor для совместимости с clone.
 */
contract PvPMarket is IMarket, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant FEE_BPS        = 0;     // TODO: сменить на 50 (0.5%) после 3 мес
    uint256 public constant MIN_BET        = 1e6;   // 1 USDC (6 decimals)
    uint256 public constant MAX_BET        = 100e6; // 100 USDC — снять после аудита
    uint256 public constant MIN_POOL_SIDE  = 10e6;  // 10 USDC на стороне для резолюции (снижено на старте)
    uint256 public constant GRACE_PERIOD   = 1 hours; // если не зарезолвлен → refund

    // ── STATE (set via initialize) ─────────────────────────
    IERC20  public usdc;
    address public resolver;
    address public feeDistributor;
    address public multisig;

    uint256 public marketOpenTime;
    uint256 public marketCloseTime;
    uint256 public duration;
    bytes32 public pythFeedId;

    Status  public status;
    bool    public upWon;
    uint256 public entryPrice;
    uint256 public exitPrice;
    uint256 public totalUpPool;
    uint256 public totalDownPool;

    bool    public initialized;

    Bet[] public upBets;
    Bet[] public downBets;

    mapping(address => uint256) public upBetIndex;   // trader => index+1 (0 = no bet)
    mapping(address => uint256) public downBetIndex;

    // ── INITIALIZE (replaces constructor for clone pattern) ─
    /**
     * @notice Инициализация рынка. Вызывается MarketFactory сразу после clone.
     * @param _usdc           Адрес USDC токена
     * @param _resolver       Адрес OracleResolver
     * @param _feeDistributor Адрес FeeDistributor
     * @param _multisig       Адрес мультисига
     * @param _duration       Длительность рынка в секундах
     * @param _pythFeedId     Pyth price feed ID
     * @param _entryPrice     Стартовая цена
     */
    function initialize(
        address _usdc,
        address _resolver,
        address _feeDistributor,
        address _multisig,
        uint256 _duration,
        bytes32 _pythFeedId,
        uint256 _entryPrice
    ) external {
        require(!initialized, "already initialized");
        initialized = true;

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
        require(initialized, "not initialized");
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
        require(amount <= MAX_BET, "above max bet");
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
        }

        emit MarketSettled(_upWon, entryPrice, exitPrice, totalUpPool, totalDownPool);
    }

    // ── CLAIM ──────────────────────────────────────────────
    /**
     * @notice Пользователь сам забирает выигрыш (pull pattern).
     */
    function claim() external override nonReentrant onlyResolved {
        uint256 idx;

        if (upWon) {
            idx = upBetIndex[msg.sender];
            require(idx > 0, "no winning bet");
        } else {
            idx = downBetIndex[msg.sender];
            require(idx > 0, "no winning bet");
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
