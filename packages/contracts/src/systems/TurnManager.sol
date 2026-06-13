// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {System} from "../system/System.sol";

/// @notice Read seam for enforcers (Phase 02 TurnBoundEnforcer reads `getCurrent`).
interface ITurnManager {
    function getCurrent(uint256 roomId) external view returns (address);
    function getTurn(uint256 roomId)
        external
        view
        returns (address current, uint64 deadlineBlock, int8 direction, uint16 turnIndex);
    function advance(uint256 roomId) external;
}

/**
 * @title TurnManager
 * @notice Built-in engine system (design §6.4). Owns turn order, per-turn deadline
 *         blocks, and a permissionless AFK timeout/skip that rotates the turn once
 *         the on-chain deadline passes — turn enforcement with no off-chain referee.
 *
 * @dev    Turn state lives in this contract's own storage. Mutating turn calls
 *         (`startTurns`, `advance`, `setDirection`) are restricted to AUTHORIZED
 *         callers — the World and writer-granted game systems — configured by the
 *         admin. `timeout` is intentionally permissionless, gated purely by the
 *         on-chain deadline, and moves NO funds (no deposit/slash economics live
 *         here; pot custody is handled by `Pot`).
 *
 *         `_msgSender()` (the redemption seam) resolves the true player from the
 *         ERC-2771 trailing bytes the World appends, attributing actions to the
 *         real player even when relayed.
 */
contract TurnManager is System {
    struct Turn {
        bool active;
        address current;
        uint64 deadlineBlock;
        int8 direction;
        uint16 turnIndex;
        uint64 turnBlocks;
    }

    address public admin;
    // `trustedRouter` (the World; when it calls, appended sender is trusted) is
    // inherited from System and gates the redemption-seam trust.
    mapping(address caller => bool) public authorized;

    mapping(uint256 roomId => Turn) internal _turn;
    mapping(uint256 roomId => address[]) internal _seats;
    mapping(uint256 roomId => mapping(address player => uint256)) internal _seatIndexPlus1;

    error TurnManager_NotActive(uint256 roomId);
    error TurnManager_DeadlineNotPassed(uint256 roomId);
    error TurnManager_AlreadyActive(uint256 roomId);
    error TurnManager_EmptyOrder();
    error TurnManager_NotAdmin();
    error TurnManager_NotAuthorized();

    event TurnManager_Started(uint256 indexed roomId, address[] order, uint64 deadlineBlock);
    event TurnManager_Advanced(uint256 indexed roomId, address current, uint16 turnIndex, uint64 deadlineBlock);
    event TurnManager_TimedOut(uint256 indexed roomId, address skipped, address reporter);
    event TurnManager_Authorized(address indexed caller, bool ok);
    event TurnManager_DirectionSet(uint256 indexed roomId, int8 direction);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert TurnManager_NotAdmin();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert TurnManager_NotAuthorized();
        _;
    }

    constructor(address _admin) {
        admin = _admin;
        authorized[_admin] = true;
    }

    function authorize(address caller, bool ok) external onlyAdmin {
        authorized[caller] = ok;
        emit TurnManager_Authorized(caller, ok);
    }

    function setTrustedRouter(address router) external onlyAdmin {
        _setTrustedRouter(router);
    }

    /// @dev Reporter resolution (for event attribution only — no funds move): only
    ///      trust the ERC-2771 appended sender when the immediate caller is the
    ///      trusted router (the World). Otherwise the reporter is the direct
    ///      `msg.sender` (permissionless path).
    function _reporter() internal view returns (address) {
        if (msg.sender == trustedRouter && trustedRouter != address(0)) {
            return _msgSender();
        }
        return msg.sender;
    }

    // ── views (the enforcer seam) ──
    function getCurrent(uint256 roomId) external view returns (address) {
        return _turn[roomId].current;
    }

    function getTurn(uint256 roomId)
        external
        view
        returns (address current, uint64 deadlineBlock, int8 direction, uint16 turnIndex)
    {
        Turn storage t = _turn[roomId];
        return (t.current, t.deadlineBlock, t.direction, t.turnIndex);
    }

    function seatsOf(uint256 roomId) external view returns (address[] memory) {
        return _seats[roomId];
    }

    // ── lifecycle ──
    function startTurns(uint256 roomId, address[] calldata order, uint64 turnBlocks) external onlyAuthorized {
        if (order.length == 0) revert TurnManager_EmptyOrder();
        if (_turn[roomId].active) revert TurnManager_AlreadyActive(roomId);

        delete _seats[roomId];
        for (uint256 i = 0; i < order.length; i++) {
            _seats[roomId].push(order[i]);
            _seatIndexPlus1[roomId][order[i]] = i + 1;
        }

        uint64 deadline = uint64(block.number) + turnBlocks;
        _turn[roomId] = Turn({
            active: true,
            current: order[0],
            deadlineBlock: deadline,
            direction: 1,
            turnIndex: 0,
            turnBlocks: turnBlocks
        });
        emit TurnManager_Started(roomId, order, deadline);
    }

    /// @notice Normal end-of-turn rotation, called by authorized game systems.
    function advance(uint256 roomId) external onlyAuthorized {
        Turn storage t = _turn[roomId];
        if (!t.active) revert TurnManager_NotActive(roomId);
        _rotate(roomId, t);
        emit TurnManager_Advanced(roomId, t.current, t.turnIndex, t.deadlineBlock);
    }

    function setDirection(uint256 roomId, int8 direction) external onlyAuthorized {
        Turn storage t = _turn[roomId];
        if (!t.active) revert TurnManager_NotActive(roomId);
        t.direction = direction;
        emit TurnManager_DirectionSet(roomId, direction);
    }

    /// @notice Permissionless AFK-skip. Gated purely by the on-chain deadline.
    ///         Any caller may report once the deadline passes; the current seat is
    ///         skipped and the turn rotates. NO funds move — this is a pure liveness
    ///         mechanism with no slash/reward economics.
    function timeout(uint256 roomId) external {
        Turn storage t = _turn[roomId];
        if (!t.active) revert TurnManager_NotActive(roomId);
        if (block.number <= t.deadlineBlock) revert TurnManager_DeadlineNotPassed(roomId);

        address skipped = t.current;
        address reporter = _reporter();

        _rotate(roomId, t);
        emit TurnManager_TimedOut(roomId, skipped, reporter);
    }

    function _rotate(uint256 roomId, Turn storage t) internal {
        address[] storage seats = _seats[roomId];
        uint256 n = seats.length;
        uint256 idx = _seatIndexPlus1[roomId][t.current] - 1;
        uint256 next;
        if (t.direction >= 0) {
            next = (idx + 1) % n;
        } else {
            next = (idx + n - 1) % n;
        }
        t.current = seats[next];
        t.turnIndex += 1;
        t.deadlineBlock = uint64(block.number) + t.turnBlocks;
    }
}
