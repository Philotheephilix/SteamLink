// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IWorld} from "@nexus/contracts/world/IWorld.sol";

/**
 * UnoTable — the public, on-chain state of an UNO room.
 *
 * Hidden hands are NOT stored here (they live sealed in the backend / LocalSecrets).
 * Only the public board state is on-chain: the top card of the discard pile
 * (color + number), the active color (for wilds), each player's hand COUNT
 * (not the cards), and the last mover. The tableId derivation matches the
 * codegen convention used by CounterTable so the InMemoryIndexer can project it.
 *
 *   tableId = bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Uno")))
 *   key:   roomId uint256
 *   value: topColor uint8, topNumber uint8, activeColor uint8,
 *          handCount uint8, lastMover address  (all static)
 */
library UnoTable {
    bytes32 internal constant _tableId = bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Uno")));

    bytes32 internal constant _keySchema = bytes32(uint256(1));
    bytes32 internal constant _valueSchema = bytes32(uint256(5));

    struct UnoData {
        uint8 topColor; // 1=red 2=green 3=blue 4=yellow (0=unset)
        uint8 topNumber; // 0..9
        uint8 activeColor; // active color after a wild; equals topColor for non-wilds
        uint8 handCount; // remaining cards in the current player's hand
        address lastMover;
    }

    function tableId() internal pure returns (bytes32) {
        return _tableId;
    }

    function register(IWorld world) internal {
        string[] memory fieldNames = new string[](5);
        fieldNames[0] = "topColor";
        fieldNames[1] = "topNumber";
        fieldNames[2] = "activeColor";
        fieldNames[3] = "handCount";
        fieldNames[4] = "lastMover";
        world.registerTable(_tableId, _keySchema, _valueSchema, fieldNames);
    }

    function _key(uint256 roomId) private pure returns (bytes32[] memory key) {
        key = new bytes32[](1);
        key[0] = bytes32(roomId);
    }

    function set(IWorld world, uint256 roomId, UnoData memory data) internal {
        bytes memory staticData =
            abi.encode(data.topColor, data.topNumber, data.activeColor, data.handCount, data.lastMover);
        world.setRecord(_tableId, _key(roomId), staticData, "");
    }

    function get(IWorld world, uint256 roomId) internal view returns (UnoData memory data) {
        (bytes memory staticData,) = world.getRecord(_tableId, _key(roomId));
        if (staticData.length == 0) {
            return UnoData({topColor: 0, topNumber: 0, activeColor: 0, handCount: 0, lastMover: address(0)});
        }
        (data.topColor, data.topNumber, data.activeColor, data.handCount, data.lastMover) =
            abi.decode(staticData, (uint8, uint8, uint8, uint8, address));
    }
}
