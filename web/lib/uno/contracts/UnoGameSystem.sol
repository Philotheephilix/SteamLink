// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {System} from "@nexus/contracts/system/System.sol";
import {IWorld} from "@nexus/contracts/world/IWorld.sol";
import {ITurnManager} from "@nexus/contracts/systems/TurnManager.sol";
import {UnoTable} from "./UnoTable.sol";

/**
 * @title UnoGameSystem
 * @notice The on-chain record + turn enforcer for a REAL, full-rules game of UNO.
 *
 *         The authoritative full-rules engine (deck, every player's private hand,
 *         legality, action effects, reshuffles, win) runs in the backend, which
 *         holds the SEALED hands (Nexus LocalSecrets) and seeds the deck order from an
 *         ON-CHAIN random word (RandomnessCoordinator). Hands are private, so they
 *         are NOT on-chain.
 *
 *         What IS on-chain, enforced here per move via the player's gameplay
 *         delegation (gasless, turn-bound through the TurnManager):
 *           - the REAL card played: (color, value) — value 0..9 for a number card,
 *             10=Skip 11=Reverse 12=Draw Two 13=Wild 14=Wild Draw Four — plus the
 *             chosen active color for a wild;
 *           - each player's remaining hand COUNT (attested by the authoritative
 *             server, which alone can see the private hand);
 *           - the win: the first player whose attested count reaches 0 emits
 *             `Uno_Won` and the room is finished (no further advance). The Pot then
 *             settles to that winner.
 *
 *         Turn order is enforced ON-CHAIN against the TurnManager. The contract
 *         records the real card and the authoritative remaining count; it trusts
 *         the turn-bound, relayed caller (the authoritative server) for the hand
 *         count and card possession, since the private hand cannot be on-chain.
 *
 *         `advanceBy` lets the server reflect action-card turn effects on-chain:
 *         a Skip / Draw Two / Wild Draw Four advances the TurnManager by 2 seats
 *         instead of 1 so the on-chain current player tracks the real game.
 */
contract UnoGameSystem is System {
    address public immutable turnManager;
    address public admin;

    // roomId => player => remaining hand count (attested by the server).
    mapping(uint256 => mapping(address => uint8)) public handOf;
    // roomId => winner (address(0) until won).
    mapping(uint256 => address) public winnerOf;

    error Uno_NotYourTurn();
    error Uno_NotAdmin();
    error Uno_BadColor();
    error Uno_BadValue();
    error Uno_Finished();
    error Uno_BadAdvance();

    event Uno_Started(uint256 indexed roomId, uint8 topColor, uint8 topValue, uint8 handCount);
    event Uno_Played(
        uint256 indexed roomId,
        address indexed player,
        uint8 color,
        uint8 value,
        uint8 activeColor,
        uint8 handCount
    );
    event Uno_Drew(uint256 indexed roomId, address indexed player, uint8 handCount);
    event Uno_Won(uint256 indexed roomId, address indexed winner);

    constructor(address _turnManager) {
        turnManager = _turnManager;
        admin = msg.sender;
    }

    function setTrustedRouter(address router) external {
        if (msg.sender != admin) revert Uno_NotAdmin();
        _setTrustedRouter(router);
    }

    /// @notice Seed a room's public board (admin-only, off the redemption path).
    function startRoom(uint256 roomId, uint8 topColor, uint8 topValue, uint8 handCount) external {
        if (msg.sender != admin) revert Uno_NotAdmin();
        if (topColor < 1 || topColor > 4) revert Uno_BadColor();
        winnerOf[roomId] = address(0);
        IWorld world = IWorld(_worldAddress());
        UnoTable.set(
            world,
            roomId,
            UnoTable.UnoData({
                topColor: topColor,
                topNumber: topValue,
                activeColor: topColor,
                handCount: handCount,
                lastMover: address(0)
            })
        );
        emit Uno_Started(roomId, topColor, topValue, handCount);
    }

    /// @notice Set `player`'s remaining hand count (admin-only; used at deal time).
    function dealHand(uint256 roomId, address player, uint8 count) external {
        if (msg.sender != admin) revert Uno_NotAdmin();
        handOf[roomId][player] = count;
    }

    /**
     * @notice Record a REAL card play. Turn-enforced on-chain; the authoritative
     *         server attests the played card and the player's new hand count.
     * @param color       0 for a wild, else 1..4 (the card's color).
     * @param value       0..9 number, or 10=Skip 11=Reverse 12=DrawTwo 13=Wild 14=WD4.
     * @param activeColor the color now in force (1..4): the card's color, or the
     *                    chosen color for a wild.
     * @param newHandCount the player's remaining cards AFTER this play (server-attested).
     * @param advanceBy   how many seats the turn advances (1 normally; 2 for a
     *                    Skip / Draw Two / Wild Draw Four; in 2-player a Reverse).
     */
    function playCard(
        uint256 roomId,
        uint8 color,
        uint8 value,
        uint8 activeColor,
        uint8 newHandCount,
        uint8 advanceBy
    ) external onlyWorld returns (address winner) {
        IWorld world = IWorld(msg.sender);
        address player = _msgSender();

        if (winnerOf[roomId] != address(0)) revert Uno_Finished();
        if (ITurnManager(turnManager).getCurrent(roomId) != player) revert Uno_NotYourTurn();
        if (color > 4) revert Uno_BadColor();
        if (value > 14) revert Uno_BadValue();
        if (activeColor < 1 || activeColor > 4) revert Uno_BadColor();
        if (advanceBy < 1 || advanceBy > 2) revert Uno_BadAdvance();

        handOf[roomId][player] = newHandCount;

        UnoTable.UnoData memory s = UnoTable.get(world, roomId);
        s.topColor = color;
        s.topNumber = value;
        s.activeColor = activeColor;
        s.handCount = newHandCount;
        s.lastMover = player;
        UnoTable.set(world, roomId, s);

        emit Uno_Played(roomId, player, color, value, activeColor, newHandCount);

        if (newHandCount == 0) {
            winnerOf[roomId] = player;
            emit Uno_Won(roomId, player);
            return player;
        }

        // Advance the on-chain turn cursor to track the real game (action effects).
        for (uint8 i = 0; i < advanceBy; i++) {
            ITurnManager(turnManager).advance(roomId);
        }
        return address(0);
    }

    /**
     * @notice Record a draw. Turn-enforced on-chain; the server attests the new
     *         hand count and whether the turn passes (advanceBy 0 = the player
     *         drew a playable card and will play it next; 1 = turn passes).
     */
    function draw(uint256 roomId, uint8 newHandCount, uint8 advanceBy) external onlyWorld {
        IWorld world = IWorld(msg.sender);
        address player = _msgSender();
        if (winnerOf[roomId] != address(0)) revert Uno_Finished();
        if (ITurnManager(turnManager).getCurrent(roomId) != player) revert Uno_NotYourTurn();
        if (advanceBy > 1) revert Uno_BadAdvance();

        handOf[roomId][player] = newHandCount;

        UnoTable.UnoData memory s = UnoTable.get(world, roomId);
        s.handCount = newHandCount;
        s.lastMover = player;
        UnoTable.set(world, roomId, s);
        emit Uno_Drew(roomId, player, newHandCount);

        if (advanceBy == 1) {
            ITurnManager(turnManager).advance(roomId);
        }
    }
}
