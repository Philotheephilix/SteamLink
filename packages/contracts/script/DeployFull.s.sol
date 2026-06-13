// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {World} from "../src/world/World.sol";
import {IWorld} from "../src/world/IWorld.sol";
import {TurnManager} from "../src/systems/TurnManager.sol";
import {CounterGameSystem} from "../src/systems/CounterGameSystem.sol";
import {CounterTable} from "../src/codegen/tables/CounterTable.sol";
import {NexusDelegationManager} from "../src/delegation/NexusDelegationManager.sol";
import {TurnBoundEnforcer} from "../src/enforcers/TurnBoundEnforcer.sol";
import {SystemAllowlistEnforcer} from "../src/enforcers/SystemAllowlistEnforcer.sol";
import {TimestampEnforcer} from "../src/enforcers/TimestampEnforcer.sol";
import {LimitedCallsEnforcer} from "../src/enforcers/LimitedCallsEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";
import {ERC20TransferAmountEnforcer} from "../src/enforcers/ERC20TransferAmountEnforcer.sol";
import {AllowedRecipientsEnforcer} from "../src/enforcers/AllowedRecipientsEnforcer.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {Pot} from "../src/Pot.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Full Nexus deployment for the live test suite: World + the real
 *         NexusDelegationManager (forwarder) + TurnManager + reference Counter
 *         game + the five caveat enforcers, fully wired, with a room seated so a
 *         player can immediately redeem a gasless move.
 *
 *         Writes all addresses to ./deployments/<chainid>.json for the TS suite.
 *
 * @dev    env:
 *           PLAYER   (address)  seated as the current turn in room ROOM_ID
 *           PLAYER2  (address)  second seat (turn rotates here after a move)
 *           ROOM_ID  (uint)     defaults to 1
 */
contract DeployFull is Script {
    function run() external {
        address player = vm.envAddress("PLAYER");
        address player2 = vm.envOr("PLAYER2", address(0));
        uint256 roomId = vm.envOr("ROOM_ID", uint256(1));

        vm.startBroadcast();

        World world = new World();
        NexusDelegationManager manager = new NexusDelegationManager();
        TurnManager tm = new TurnManager(msg.sender);
        CounterGameSystem game = new CounterGameSystem(address(tm));

        CounterTable.register(IWorld(address(world)));
        world.registerSystem(bytes32("CounterGame"), address(game));
        world.grantWriteAccess(CounterTable.tableId(), address(game));
        world.setTrustedForwarder(address(manager));

        // Wire the game's trusted router to the World (deployed above) so the game
        // honors the appended sender only on the World-routed path, and `onlyWorld`
        // rejects spoofed direct calls.
        game.setTrustedRouter(address(world));

        tm.authorize(address(game), true); // game may advance()
        tm.authorize(msg.sender, true); // deployer may seat the room
        tm.setTrustedRouter(address(world));

        // Seat the room so PLAYER is the current turn.
        address[] memory order = new address[](player2 == address(0) ? 1 : 2);
        order[0] = player;
        if (player2 != address(0)) order[1] = player2;
        tm.startTurns(roomId, order, 5000);

        TurnBoundEnforcer turnBound = new TurnBoundEnforcer();
        SystemAllowlistEnforcer systemAllowlist = new SystemAllowlistEnforcer();
        TimestampEnforcer timestamp = new TimestampEnforcer();
        LimitedCallsEnforcer limitedCalls = new LimitedCallsEnforcer();
        PerActionCapEnforcer perActionCap = new PerActionCapEnforcer();
        ERC20TransferAmountEnforcer erc20TransferAmount = new ERC20TransferAmountEnforcer();
        AllowedRecipientsEnforcer allowedRecipients = new AllowedRecipientsEnforcer();

        // ── LOCAL x402 budget rails: a real 6-decimals TestUSDC + a Pot to receive
        //    charges. The deployer (the payer/relayer on anvil) is minted a balance.
        //    On Base Sepolia the TS suite ignores `testUsdc` and uses canonical USDC.
        TestUSDC testUsdc = new TestUSDC();
        Pot pot = new Pot(IERC20(address(testUsdc)), msg.sender, msg.sender, 0);
        testUsdc.mint(msg.sender, 1000e6);

        vm.stopBroadcast();

        // ── emit addresses as JSON ──
        string memory enf = "enforcers";
        vm.serializeAddress(enf, "turnBound", address(turnBound));
        vm.serializeAddress(enf, "systemAllowlist", address(systemAllowlist));
        vm.serializeAddress(enf, "timestamp", address(timestamp));
        vm.serializeAddress(enf, "limitedCalls", address(limitedCalls));
        vm.serializeAddress(enf, "perActionCap", address(perActionCap));
        vm.serializeAddress(enf, "erc20TransferAmount", address(erc20TransferAmount));
        string memory enforcersJson = vm.serializeAddress(enf, "allowedRecipients", address(allowedRecipients));

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "world", address(world));
        vm.serializeAddress(root, "delegationManager", address(manager));
        vm.serializeAddress(root, "turnManager", address(tm));
        vm.serializeAddress(root, "counterGame", address(game));
        vm.serializeBytes32(root, "counterGameSystemId", bytes32("CounterGame"));
        vm.serializeAddress(root, "testUsdc", address(testUsdc));
        vm.serializeAddress(root, "pot", address(pot));
        vm.serializeUint(root, "roomId", roomId);
        string memory out = vm.serializeString(root, "enforcers", enforcersJson);

        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("Nexus deployed. addresses written to", path);
        console.log("World:", address(world));
        console.log("DelegationManager:", address(manager));
    }
}
