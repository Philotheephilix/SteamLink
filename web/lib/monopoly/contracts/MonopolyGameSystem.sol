// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {System} from "@nexus-contracts/system/System.sol";
import {IWorld} from "@nexus-contracts/world/IWorld.sol";
import {ITurnManager} from "@nexus-contracts/systems/TurnManager.sol";
import {PlayerTable, PropertyTable} from "./MonopolyTables.sol";

interface IRandomnessCoordinator {
    function fastRandom() external returns (uint256 randomWord);
    function dice(uint256 randomWord, uint8 sides, uint8 count) external pure returns (uint8[] memory);
}

/**
 * @title MonopolyGameSystem
 * @notice The ON-CHAIN record + dice for a FULL-RULES Nexus Monopoly. The
 *         authoritative rules engine (board, cash, houses, mortgages, jail, decks,
 *         rent, bankruptcy, win) runs in the backend; THIS contract provides the
 *         on-chain rails the rules ride on:
 *
 *          - `rollAndMove`: the player's turn-bound, GASLESS dice roll. Dice come
 *            from the on-chain RandomnessCoordinator (a real RNG event in the
 *            receipt) so fairness is provable. It records the new board position and
 *            advances the turn. Redeemed through the player's OWN gameplay delegation.
 *          - `recordAction`: a generic, turn-bound record of EVERY other player
 *            action (buy / pay-rent / pay-tax / build / mortgage / end-turn). Also
 *            redeemed through the player's gameplay delegation so each action is a
 *            real on-chain event signed for by that player — not a server fiat.
 *          - admin records (`recordBuy`/`recordRent`/`recordOwner`/`setCash`) let the
 *            relayer (the game admin) mirror authoritative state into the World tables
 *            for the indexer/UI.
 *
 *         The real USDC economy (buy / rent / tax → Pot) is settled OFF this contract
 *         through the x402 budget-delegation charge path (the proven Nexus payment
 *         rail), each bounded by on-chain spend caps + a recipient allowlist.
 */
contract MonopolyGameSystem is System {
    address public immutable turnManager;
    address public immutable randomness;
    address public admin;

    uint8 public constant BOARD_SIZE = 40;
    uint256 public constant START_CASH = 80e6; // 80 in-game dollars (6dp ledger)
    uint256 public constant GO_BONUS = 60e6; // smaller-bankroll variant (see lib/board)

    error Monopoly_NotYourTurn();
    error Monopoly_NotAdmin();

    event Monopoly_Joined(uint256 indexed roomId, address indexed player, uint256 cash);
    event Monopoly_Rolled(
        uint256 indexed roomId,
        address indexed player,
        uint8 die1,
        uint8 die2,
        uint256 fromPos,
        uint256 toPos,
        bool passedGo
    );
    /// @notice A generic on-chain record of a player action, signed for by the player
    ///         (turn-bound, gasless). `action` is a short tag the backend assigns
    ///         (e.g. "buy","rent","tax","build","mortgage","unmortgage","jail","end").
    event Monopoly_Action(
        uint256 indexed roomId, address indexed player, bytes32 indexed action, uint256 spaceId, uint256 amount
    );
    event Monopoly_Bought(uint256 indexed roomId, address indexed player, uint256 spaceId, uint256 price);
    event Monopoly_RentPaid(
        uint256 indexed roomId, address indexed payer, address indexed owner, uint256 spaceId, uint256 rent
    );
    event Monopoly_Bankrupt(uint256 indexed roomId, address indexed player);

    constructor(address _turnManager, address _randomness) {
        turnManager = _turnManager;
        randomness = _randomness;
        admin = msg.sender;
    }

    function setTrustedRouter(address router) external {
        if (msg.sender != admin) revert Monopoly_NotAdmin();
        _setTrustedRouter(router);
    }

    /// @notice Seat a player with the starting cash. Idempotent-ish: overwrites the row.
    function joinGame(uint256 roomId) external onlyWorld {
        IWorld world = IWorld(msg.sender);
        address player = _msgSender();
        PlayerTable.set(world, roomId, player, PlayerTable.PlayerData({position: 0, cash: START_CASH}));
        emit Monopoly_Joined(roomId, player, START_CASH);
    }

    /// @notice Roll 2d6 on the caller's turn, move around the full 40-space board.
    ///         Dice come from the on-chain RandomnessCoordinator. Does NOT advance the
    ///         turn — the player may have post-roll actions (buy/build) and doubles
    ///         grant another roll; the turn advances only on the player-signed
    ///         `endTurn`. Every roll is turn-bound + gasless (gameplay delegation).
    function rollAndMove(uint256 roomId) external onlyWorld returns (uint8 die1, uint8 die2, uint256 newPos) {
        IWorld world = IWorld(msg.sender);
        address player = _msgSender();

        if (ITurnManager(turnManager).getCurrent(roomId) != player) revert Monopoly_NotYourTurn();

        PlayerTable.PlayerData memory p = PlayerTable.get(world, roomId, player);
        if (p.cash == 0 && p.position == 0) p.cash = START_CASH;

        uint256 word = IRandomnessCoordinator(randomness).fastRandom();
        uint8[] memory rolls = IRandomnessCoordinator(randomness).dice(word, 6, 2);
        die1 = rolls[0];
        die2 = rolls[1];

        uint256 fromPos = p.position;
        uint256 steps = uint256(die1) + uint256(die2);
        uint256 raw = fromPos + steps;
        bool passedGo = raw >= BOARD_SIZE;
        newPos = raw % BOARD_SIZE;

        p.position = newPos;
        if (passedGo) p.cash += GO_BONUS;
        PlayerTable.set(world, roomId, player, p);

        emit Monopoly_Rolled(roomId, player, die1, die2, fromPos, newPos, passedGo);
        return (die1, die2, newPos);
    }

    /// @notice Record a generic player action on-chain, signed for by the player via
    ///         their gameplay delegation (turn-bound). The backend assigns the action
    ///         tag + amount; the on-chain event is the player's signed acknowledgement
    ///         of that action. Does NOT advance the turn.
    function recordAction(uint256 roomId, bytes32 action, uint256 spaceId, uint256 amount) external onlyWorld {
        address player = _msgSender();
        if (ITurnManager(turnManager).getCurrent(roomId) != player) revert Monopoly_NotYourTurn();
        emit Monopoly_Action(roomId, player, action, spaceId, amount);
    }

    /// @notice End the caller's turn: a turn-bound, GASLESS player-signed action that
    ///         advances the TurnManager to the next player. The backend's authoritative
    ///         rules decide WHEN a turn ends (after the player resolves all post-roll
    ///         actions; doubles let them roll again first). Redeemed through the
    ///         player's gameplay delegation, so the turn advance is signed by the player.
    function endTurn(uint256 roomId) external onlyWorld {
        address player = _msgSender();
        if (ITurnManager(turnManager).getCurrent(roomId) != player) revert Monopoly_NotYourTurn();
        emit Monopoly_Action(roomId, player, bytes32("end"), 0, 0);
        ITurnManager(turnManager).advance(roomId);
    }

    // ── admin mirrors of authoritative state (the relayer/game admin) ──

    function recordBuy(uint256 roomId, uint256 spaceId, address player, uint256 price, uint256 rent)
        external
        onlyWorld
    {
        IWorld world = IWorld(msg.sender);
        if (_msgSender() != admin) revert Monopoly_NotAdmin();
        PropertyTable.set(world, roomId, spaceId, PropertyTable.PropertyData({owner: player, price: price, rent: rent}));
        emit Monopoly_Bought(roomId, player, spaceId, price);
    }

    function recordRent(uint256 roomId, uint256 spaceId, address player) external onlyWorld {
        IWorld world = IWorld(msg.sender);
        if (_msgSender() != admin) revert Monopoly_NotAdmin();
        PropertyTable.PropertyData memory prop = PropertyTable.get(world, roomId, spaceId);
        if (prop.owner == address(0) || prop.owner == player) return;
        emit Monopoly_RentPaid(roomId, player, prop.owner, spaceId, prop.rent);
    }

    /// @notice Set/transfer property ownership (used on bankruptcy asset transfer or
    ///         building updates). Admin op mirroring the authoritative engine.
    function recordOwner(uint256 roomId, uint256 spaceId, address owner, uint256 price, uint256 rent)
        external
        onlyWorld
    {
        IWorld world = IWorld(msg.sender);
        if (_msgSender() != admin) revert Monopoly_NotAdmin();
        PropertyTable.set(world, roomId, spaceId, PropertyTable.PropertyData({owner: owner, price: price, rent: rent}));
    }

    /// @notice Mirror a player's authoritative cash + position into the World table.
    function setCash(uint256 roomId, address player, uint256 cash, uint256 position) external onlyWorld {
        IWorld world = IWorld(msg.sender);
        if (_msgSender() != admin) revert Monopoly_NotAdmin();
        PlayerTable.set(world, roomId, player, PlayerTable.PlayerData({position: position, cash: cash}));
    }

    /// @notice Mark a player bankrupt (event only; ownership transfer via recordOwner).
    function recordBankrupt(uint256 roomId, address player) external onlyWorld {
        if (_msgSender() != admin) revert Monopoly_NotAdmin();
        emit Monopoly_Bankrupt(roomId, player);
    }

    // ── reads ──
    function positionOf(uint256 roomId, address player) external view returns (uint256) {
        return PlayerTable.get(IWorld(trustedRouter), roomId, player).position;
    }

    function cashOf(uint256 roomId, address player) external view returns (uint256) {
        return PlayerTable.get(IWorld(trustedRouter), roomId, player).cash;
    }

    function ownerOf(uint256 roomId, uint256 spaceId) external view returns (address) {
        return PropertyTable.get(IWorld(trustedRouter), roomId, spaceId).owner;
    }
}
