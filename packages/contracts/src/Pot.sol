// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Pot
 * @notice A simple, trustless USDC escrow per roomId. Players deposit entry fees;
 *         on settle the winner is paid the balance minus a rake (bps) credited to
 *         the rake collector. Settlement is admin-keyless: only the registered
 *         settle authority (the World / a registered settle system) may call it.
 */
contract Pot is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token; // USDC on Base
    address public immutable settleAuthority; // World or registered settle system
    address public immutable rakeCollector;
    uint16 public immutable rakeBps; // e.g. 200 = 2%

    struct PotState {
        bool open;
        bool settled;
        uint256 balance;
    }

    mapping(uint256 roomId => PotState) public pots;
    mapping(uint256 roomId => mapping(address player => uint256)) public deposited;

    error Pot_NotSettleAuthority();
    error Pot_NotOpen(uint256 roomId);
    error Pot_AlreadyOpen(uint256 roomId);
    error Pot_AlreadySettled(uint256 roomId);
    error Pot_RakeTooHigh();
    error Pot_WinnerNotParticipant(uint256 roomId, address winner);

    event Pot_Opened(uint256 indexed roomId);
    event Pot_Deposited(uint256 indexed roomId, address indexed player, uint256 amount);
    event Pot_Settled(uint256 indexed roomId, address indexed winner, uint256 payout, uint256 rake);

    constructor(IERC20 _token, address _settleAuthority, address _rakeCollector, uint16 _rakeBps) {
        if (_rakeBps > 10_000) revert Pot_RakeTooHigh();
        token = _token;
        settleAuthority = _settleAuthority;
        rakeCollector = _rakeCollector;
        rakeBps = _rakeBps;
    }

    modifier onlySettleAuthority() {
        if (msg.sender != settleAuthority) revert Pot_NotSettleAuthority();
        _;
    }

    function openPot(uint256 roomId) external onlySettleAuthority {
        if (pots[roomId].open || pots[roomId].settled) revert Pot_AlreadyOpen(roomId);
        pots[roomId].open = true;
        emit Pot_Opened(roomId);
    }

    /// @notice Deposit `amount` of the budget token for `roomId`. Caller must approve first.
    function deposit(uint256 roomId, uint256 amount) external nonReentrant {
        PotState storage p = pots[roomId];
        if (!p.open) revert Pot_NotOpen(roomId);
        if (p.settled) revert Pot_AlreadySettled(roomId);

        token.safeTransferFrom(msg.sender, address(this), amount);
        p.balance += amount;
        deposited[roomId][msg.sender] += amount;
        emit Pot_Deposited(roomId, msg.sender, amount);
    }

    /// @notice Pay the winner the pot balance minus rake. Trustless, admin-keyless.
    function settle(uint256 roomId, address winner) external nonReentrant onlySettleAuthority {
        PotState storage p = pots[roomId];
        if (!p.open) revert Pot_NotOpen(roomId);
        if (p.settled) revert Pot_AlreadySettled(roomId);
        if (deposited[roomId][winner] == 0) revert Pot_WinnerNotParticipant(roomId, winner);

        uint256 total = p.balance;
        uint256 rake = (total * rakeBps) / 10_000;
        uint256 payout = total - rake;

        p.settled = true;
        p.open = false;
        p.balance = 0;

        if (rake > 0) token.safeTransfer(rakeCollector, rake);
        if (payout > 0) token.safeTransfer(winner, payout);

        emit Pot_Settled(roomId, winner, payout, rake);
    }
}
