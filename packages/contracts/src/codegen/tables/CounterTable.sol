// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IWorld} from "../../world/IWorld.sol";

/**
 * @title CounterTable
 * @notice Hand-written example of the Phase 03 codegen target shape. A table
 *         `Counter: { roomId: uint256 (key), value: uint256, lastMover: address }`.
 *         Demonstrates typed set/get round-tripping through the World store.
 */
library CounterTable {
    // tableId derivation: a 2-byte resource prefix ("tb" = table), 14 zero bytes of
    // namespace, then the 16-byte table name ("Counter"), packed into one bytes32.
    // This namespacing scheme is what the codegen reproduces so a table name maps
    // to a unique, collision-resistant id without a registry lookup.
    bytes32 internal constant _tableId = bytes32(abi.encodePacked(bytes2("tb"), bytes14(0), bytes16("Counter")));

    // Schemas here are simplified field-count tags (1 key field, 2 value fields)
    // rather than the packed per-field type encoding the full codegen emits — this
    // hand-written table only needs them to satisfy the World registry signature.
    // keySchema: one uint256 key; valueSchema: uint256 + address (static fields)
    bytes32 internal constant _keySchema = bytes32(uint256(1));
    bytes32 internal constant _valueSchema = bytes32(uint256(2));

    struct CounterData {
        uint256 value;
        address lastMover;
    }

    function tableId() internal pure returns (bytes32) {
        return _tableId;
    }

    function register(IWorld world) internal {
        string[] memory fieldNames = new string[](2);
        fieldNames[0] = "value";
        fieldNames[1] = "lastMover";
        world.registerTable(_tableId, _keySchema, _valueSchema, fieldNames);
    }

    function _key(uint256 roomId) private pure returns (bytes32[] memory key) {
        key = new bytes32[](1);
        key[0] = bytes32(roomId);
    }

    /// @notice Pack a CounterData record and write it to the World store under roomId.
    /// @dev Both fields are fixed-width, so the whole record is `staticData` and the
    ///      dynamic blob is empty.
    function set(IWorld world, uint256 roomId, CounterData memory data) internal {
        bytes memory staticData = abi.encode(data.value, data.lastMover);
        world.setRecord(_tableId, _key(roomId), staticData, "");
    }

    /// @notice Read and unpack the Counter record for roomId, defaulting to zero
    ///         when no record has been written yet.
    function get(IWorld world, uint256 roomId) internal view returns (CounterData memory data) {
        (bytes memory staticData,) = world.getRecord(_tableId, _key(roomId));
        // An unset record reads back as empty bytes; treat that as the zero value so
        // the first move starts from value 0 rather than reverting on abi.decode.
        if (staticData.length == 0) return CounterData({value: 0, lastMover: address(0)});
        (data.value, data.lastMover) = abi.decode(staticData, (uint256, address));
    }
}
