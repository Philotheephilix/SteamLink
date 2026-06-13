// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Canonical store event set — the indexer (Phase 06) subscribes to exactly these.
interface IStoreEvents {
    event Store_SetRecord(bytes32 indexed tableId, bytes32[] keyTuple, bytes staticData, bytes dynamicData);
    event Store_DeleteRecord(bytes32 indexed tableId, bytes32[] keyTuple);
}

interface IWorldEvents {
    event World_TableRegistered(bytes32 indexed tableId, bytes32 keySchema, bytes32 valueSchema, string[] fieldNames);
    event World_SystemRegistered(bytes32 indexed systemId, address indexed systemAddr);
    event World_HelloWorld(bytes32 worldVersion);
}

/// @notice The World's external surface, consumed by systems, enforcers, and the indexer.
interface IWorld is IStoreEvents, IWorldEvents {
    // registry
    function registerTable(
        bytes32 tableId,
        bytes32 keySchema,
        bytes32 valueSchema,
        string[] calldata fieldNames
    ) external;
    /// @dev System-call authorization is enforced via delegation caveats, not here.
    function registerSystem(bytes32 systemId, address systemAddr) external;

    // routing (the redemption entry point)
    function call(bytes32 systemId, bytes calldata callData) external returns (bytes memory);

    // store (gated by access control)
    function setRecord(bytes32 tableId, bytes32[] calldata key, bytes calldata staticData, bytes calldata dynamicData)
        external;
    function getRecord(bytes32 tableId, bytes32[] calldata key)
        external
        view
        returns (bytes memory staticData, bytes memory dynamicData);
    function deleteRecord(bytes32 tableId, bytes32[] calldata key) external;

    // access control + seam
    function grantWriteAccess(bytes32 tableId, address writer) external;
    function revokeWriteAccess(bytes32 tableId, address writer) external;
    function setTrustedForwarder(address forwarder) external;
    function getSystemAddress(bytes32 systemId) external view returns (address);
}
