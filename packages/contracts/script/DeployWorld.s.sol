// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {World} from "../src/world/World.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";
import {CounterGameSystem} from "../src/systems/CounterGameSystem.sol";
import {CounterTable} from "../src/codegen/tables/CounterTable.sol";
import {IWorld} from "../src/world/IWorld.sol";
import {TurnBoundEnforcer} from "../src/enforcers/TurnBoundEnforcer.sol";
import {SystemAllowlistEnforcer} from "../src/enforcers/SystemAllowlistEnforcer.sol";
import {TimestampEnforcer} from "../src/enforcers/TimestampEnforcer.sol";
import {LimitedCallsEnforcer} from "../src/enforcers/LimitedCallsEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";

/**
 * @notice Deploys the World, the built-in TurnManager, the reference Counter game,
 *         registers their tables/systems, wires access control, and deploys the
 *         five caveat enforcers. Phase 11's CLI generalizes this from a manifest.
 *
 * @dev    The trusted forwarder (the canonical MetaMask DelegationManager on Base)
 *         is passed via the FORWARDER env var. See src/delegation/IDelegation.sol.
 */
contract DeployWorld is Script {
    function run() external {
        address forwarder = vm.envOr("FORWARDER", address(0));
        vm.startBroadcast();

        World world = new World();
        TurnManager tm = new TurnManager(msg.sender);
        CounterGameSystem game = new CounterGameSystem(address(tm));

        CounterTable.register(IWorld(address(world)));
        world.registerSystem(bytes32("CounterGame"), address(game));
        world.grantWriteAccess(CounterTable.tableId(), address(game));
        tm.authorize(address(game), true);

        if (forwarder != address(0)) world.setTrustedForwarder(forwarder);

        // enforcers (Phase 02)
        new TurnBoundEnforcer();
        new SystemAllowlistEnforcer();
        new TimestampEnforcer();
        new LimitedCallsEnforcer();
        new PerActionCapEnforcer();

        vm.stopBroadcast();
    }
}
