// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Pot
 * @notice A USDC escrow per roomId for a winner-take-all game. Players deposit;
 *         the winner is paid the balance minus a rake.
 *
 * @dev    HARDENED (audit C2). The single-EOA "name any winner, drain instantly"
 *         risk is bounded by FOUR independent mechanisms:
 *
 *           1. TIMELOCK — settlement is two-step: `proposeWinner` records the
 *              winner + an `eta` (now + settleDelayBlocks); `executeSettle` only
 *              moves funds AFTER `eta`. A compromised settle key cannot drain in a
 *              single block — there is a public, watchable delay window.
 *           2. GUARDIAN PAUSE — a SEPARATE `guardian` key (intended: a multisig)
 *              can `setPaused(true)` and `cancelProposal()` a pending payout during
 *              the window, so a detected compromise can be frozen.
 *           3. PULL PAYMENTS — settlement only CREDITS `owed[winner]` /
 *              `owed[rakeCollector]`; recipients `withdraw()` themselves. A
 *              blocklisted/contract recipient can never brick settlement for others.
 *           4. REFUND TIMEOUT — if a pot is never settled by its `refundDeadline`,
 *              each player can `refund()` their own deposit, so funds can never be
 *              permanently locked by an absent/lost authority.
 *
 *         RESIDUAL TRUST: the settle authority still NAMES the winner (there is no
 *         on-chain game-outcome proof here). Deploy `settleAuthority` AND `guardian`
 *         as DISTINCT multisigs so no single key both proposes and approves a payout.
 */
contract Pot is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token; // USDC
    address public immutable settleAuthority; // proposes the winner (should be a multisig)
    address public immutable guardian; // pause / cancel (a DISTINCT multisig)
    address public immutable rakeCollector;
    uint16 public immutable rakeBps; // e.g. 200 = 2%
    uint64 public immutable settleDelayBlocks; // timelock between propose and execute
    uint64 public immutable refundWindowBlocks; // openPot -> refundDeadline

    bool public paused;

    struct PotState {
        bool open;
        bool settled;
        uint256 balance;
        uint64 refundDeadline; // block after which an un-settled pot is refundable
    }

    struct Proposal {
        bool exists;
        address winner;
        uint64 eta; // block at/after which executeSettle is allowed
    }

    mapping(uint256 roomId => PotState) public pots;
    mapping(uint256 roomId => Proposal) public proposals;
    mapping(uint256 roomId => mapping(address player => uint256)) public deposited;
    /// @notice Pull-payment balances (settlement payouts + rake). Withdraw separately.
    mapping(address account => uint256) public owed;

    error Pot_NotSettleAuthority();
    error Pot_NotGuardian();
    error Pot_Paused();
    error Pot_NotOpen(uint256 roomId);
    error Pot_AlreadyOpen(uint256 roomId);
    error Pot_AlreadySettled(uint256 roomId);
    error Pot_RakeTooHigh();
    error Pot_WinnerNotParticipant(uint256 roomId, address winner);
    error Pot_NoProposal(uint256 roomId);
    error Pot_TimelockNotElapsed(uint256 roomId, uint64 eta);
    error Pot_RefundNotYet(uint256 roomId, uint64 refundDeadline);
    error Pot_NothingToWithdraw();
    error Pot_NothingToRefund(uint256 roomId);
    error Pot_ZeroAddress();

    event Pot_Opened(uint256 indexed roomId, uint64 refundDeadline);
    event Pot_Deposited(uint256 indexed roomId, address indexed player, uint256 amount);
    event Pot_WinnerProposed(uint256 indexed roomId, address indexed winner, uint64 eta);
    event Pot_ProposalCancelled(uint256 indexed roomId, address indexed winner);
    event Pot_Settled(uint256 indexed roomId, address indexed winner, uint256 payout, uint256 rake);
    event Pot_Refunded(uint256 indexed roomId, address indexed player, uint256 amount);
    event Pot_Withdrawn(address indexed account, uint256 amount);
    event Pot_PausedSet(bool paused);

    constructor(
        IERC20 _token,
        address _settleAuthority,
        address _rakeCollector,
        uint16 _rakeBps,
        address _guardian,
        uint64 _settleDelayBlocks,
        uint64 _refundWindowBlocks
    ) {
        if (_rakeBps > 10_000) revert Pot_RakeTooHigh();
        if (address(_token) == address(0) || _settleAuthority == address(0) || _guardian == address(0)) {
            revert Pot_ZeroAddress();
        }
        token = _token;
        settleAuthority = _settleAuthority;
        rakeCollector = _rakeCollector;
        rakeBps = _rakeBps;
        guardian = _guardian;
        settleDelayBlocks = _settleDelayBlocks;
        refundWindowBlocks = _refundWindowBlocks;
    }

    modifier onlySettleAuthority() {
        if (msg.sender != settleAuthority) revert Pot_NotSettleAuthority();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Pot_NotGuardian();
        _;
    }

    // ── guardian controls ──

    /// @notice Freeze/unfreeze winner proposals and settlement execution.
    function setPaused(bool _paused) external onlyGuardian {
        paused = _paused;
        emit Pot_PausedSet(_paused);
    }

    // ── lifecycle ──

    function openPot(uint256 roomId) external onlySettleAuthority {
        PotState storage p = pots[roomId];
        if (p.open || p.settled) revert Pot_AlreadyOpen(roomId);
        p.open = true;
        p.refundDeadline = uint64(block.number) + refundWindowBlocks;
        emit Pot_Opened(roomId, p.refundDeadline);
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

    // ── settlement (two-step, timelocked) ──

    /// @notice Step 1: propose the winner. Starts the timelock; does NOT move funds.
    function proposeWinner(uint256 roomId, address winner) external onlySettleAuthority {
        if (paused) revert Pot_Paused();
        PotState storage p = pots[roomId];
        if (!p.open) revert Pot_NotOpen(roomId);
        if (p.settled) revert Pot_AlreadySettled(roomId);
        if (deposited[roomId][winner] == 0) revert Pot_WinnerNotParticipant(roomId, winner);

        uint64 eta = uint64(block.number) + settleDelayBlocks;
        proposals[roomId] = Proposal({exists: true, winner: winner, eta: eta});
        emit Pot_WinnerProposed(roomId, winner, eta);
    }

    /// @notice Guardian (or the authority) may cancel a pending proposal during the window.
    function cancelProposal(uint256 roomId) external {
        if (msg.sender != guardian && msg.sender != settleAuthority) revert Pot_NotGuardian();
        Proposal storage prop = proposals[roomId];
        if (!prop.exists) revert Pot_NoProposal(roomId);
        address w = prop.winner;
        delete proposals[roomId];
        emit Pot_ProposalCancelled(roomId, w);
    }

    /// @notice Step 2: after the timelock, credit the winner + rake to pull balances.
    ///         Callable by anyone (the timelock + guardian are the protection); a
    ///         blocklisted winner cannot block this because payout is pull-based.
    function executeSettle(uint256 roomId) external nonReentrant {
        if (paused) revert Pot_Paused();
        PotState storage p = pots[roomId];
        if (!p.open) revert Pot_NotOpen(roomId);
        if (p.settled) revert Pot_AlreadySettled(roomId);

        Proposal storage prop = proposals[roomId];
        if (!prop.exists) revert Pot_NoProposal(roomId);
        if (block.number < prop.eta) revert Pot_TimelockNotElapsed(roomId, prop.eta);

        address winner = prop.winner;
        uint256 total = p.balance;
        uint256 rake = (total * rakeBps) / 10_000;
        uint256 payout = total - rake;

        // effects (CEI) — credit pull balances, never push transfers
        p.settled = true;
        p.open = false;
        p.balance = 0;
        delete proposals[roomId];
        if (rake > 0 && rakeCollector != address(0)) owed[rakeCollector] += rake;
        if (payout > 0) owed[winner] += payout;

        emit Pot_Settled(roomId, winner, payout, rake);
    }

    // ── pull payments ──

    /// @notice Withdraw your accumulated payouts/rake. CEI + nonReentrant.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert Pot_NothingToWithdraw();
        owed[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Pot_Withdrawn(msg.sender, amount);
    }

    // ── refund timeout ──

    /// @notice If a pot is never settled by its `refundDeadline`, reclaim your own
    ///         deposit. Guarantees funds can never be permanently locked.
    function refund(uint256 roomId) external nonReentrant {
        PotState storage p = pots[roomId];
        if (!p.open) revert Pot_NotOpen(roomId);
        if (p.settled) revert Pot_AlreadySettled(roomId);
        if (block.number <= p.refundDeadline) revert Pot_RefundNotYet(roomId, p.refundDeadline);

        uint256 amount = deposited[roomId][msg.sender];
        if (amount == 0) revert Pot_NothingToRefund(roomId);

        deposited[roomId][msg.sender] = 0;
        p.balance -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Pot_Refunded(roomId, msg.sender, amount);
    }
}
