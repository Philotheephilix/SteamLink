// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IWorld} from "@nexus-contracts/world/IWorld.sol";

/**
 * @title PlayerTable
 * @notice Per-(roomId, player) Monopoly state: board position + cash.
 *         Hand-written in the CounterTable codegen-target shape.
 *
 *         table `Player: { roomId uint256(key), addr address(key), position uint8, cash uint256 }`
 */
library PlayerTable {
    bytes32 internal constant _tableId =
        bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Player")));

    // 2 key fields, 2 value fields
    bytes32 internal constant _keySchema = bytes32(uint256(2));
    bytes32 internal constant _valueSchema = bytes32(uint256(2));

    struct PlayerData {
        uint256 position;
        uint256 cash;
    }

    function tableId() internal pure returns (bytes32) {
        return _tableId;
    }

    function register(IWorld world) internal {
        string[] memory fieldNames = new string[](2);
        fieldNames[0] = "position";
        fieldNames[1] = "cash";
        world.registerTable(_tableId, _keySchema, _valueSchema, fieldNames);
    }

    function _key(uint256 roomId, address addr) private pure returns (bytes32[] memory key) {
        key = new bytes32[](2);
        key[0] = bytes32(roomId);
        key[1] = bytes32(uint256(uint160(addr)));
    }

    function set(IWorld world, uint256 roomId, address addr, PlayerData memory data) internal {
        bytes memory staticData = abi.encode(data.position, data.cash);
        world.setRecord(_tableId, _key(roomId, addr), staticData, "");
    }

    function get(IWorld world, uint256 roomId, address addr) internal view returns (PlayerData memory data) {
        (bytes memory staticData,) = world.getRecord(_tableId, _key(roomId, addr));
        if (staticData.length == 0) return PlayerData({position: 0, cash: 0});
        (data.position, data.cash) = abi.decode(staticData, (uint256, uint256));
    }
}

/**
 * @title PropertyTable
 * @notice Per-(roomId, spaceId) property ownership.
 *         table `Property: { roomId uint256(key), spaceId uint8(key), owner address, price uint256, rent uint256 }`
 */
library PropertyTable {
    bytes32 internal constant _tableId =
        bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Property")));

    bytes32 internal constant _keySchema = bytes32(uint256(2));
    bytes32 internal constant _valueSchema = bytes32(uint256(3));

    struct PropertyData {
        address owner;
        uint256 price;
        uint256 rent;
    }

    function tableId() internal pure returns (bytes32) {
        return _tableId;
    }

    function register(IWorld world) internal {
        string[] memory fieldNames = new string[](3);
        fieldNames[0] = "owner";
        fieldNames[1] = "price";
        fieldNames[2] = "rent";
        world.registerTable(_tableId, _keySchema, _valueSchema, fieldNames);
    }

    function _key(uint256 roomId, uint256 spaceId) private pure returns (bytes32[] memory key) {
        key = new bytes32[](2);
        key[0] = bytes32(roomId);
        key[1] = bytes32(spaceId);
    }

    function set(IWorld world, uint256 roomId, uint256 spaceId, PropertyData memory data) internal {
        bytes memory staticData = abi.encode(data.owner, data.price, data.rent);
        world.setRecord(_tableId, _key(roomId, spaceId), staticData, "");
    }

    function get(IWorld world, uint256 roomId, uint256 spaceId) internal view returns (PropertyData memory data) {
        (bytes memory staticData,) = world.getRecord(_tableId, _key(roomId, spaceId));
        if (staticData.length == 0) return PropertyData({owner: address(0), price: 0, rent: 0});
        (data.owner, data.price, data.rent) = abi.decode(staticData, (address, uint256, uint256));
    }
}
