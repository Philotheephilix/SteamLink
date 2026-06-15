// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {World} from "@nexus/contracts/world/World.sol";
import {IWorld} from "@nexus/contracts/world/IWorld.sol";
import {TurnManager} from "@nexus/contracts/systems/TurnManager.sol";
import {NexusDelegationManager} from "@nexus/contracts/delegation/NexusDelegationManager.sol";
import {TurnBoundEnforcer} from "@nexus/contracts/enforcers/TurnBoundEnforcer.sol";
import {SystemAllowlistEnforcer} from "@nexus/contracts/enforcers/SystemAllowlistEnforcer.sol";
import {TimestampEnforcer} from "@nexus/contracts/enforcers/TimestampEnforcer.sol";
import {LimitedCallsEnforcer} from "@nexus/contracts/enforcers/LimitedCallsEnforcer.sol";
import {PerActionCapEnforcer} from "@nexus/contracts/enforcers/PerActionCapEnforcer.sol";
import {ERC20TransferAmountEnforcer} from "@nexus/contracts/enforcers/ERC20TransferAmountEnforcer.sol";
import {AllowedRecipientsEnforcer} from "@nexus/contracts/enforcers/AllowedRecipientsEnforcer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RandomnessCoordinator} from "@nexus/contracts/randomness/RandomnessCoordinator.sol";
import {UnoGameSystem} from "./UnoGameSystem.sol";
import {UnoTable} from "./UnoTable.sol";
import {UnoPot} from "./UnoPot.sol";

/**
 * DeployUno — deploys the full Nexus stack + the UNO game on Base Sepolia.
 *
 * Mirrors packages/contracts/script/DeployFull.s.sol exactly, swapping the
 * CounterGame for the UnoGameSystem and using the REAL Base Sepolia USDC
 * (env USDC_ADDRESS) as the budget/entry-fee token so the 1-USDC entry fee is a
 * real on-chain transfer. The Pot's settleAuthority is the deployer (relayer).
 *
 * Env:
 *   PLAYER        — seat 0 (the player). default = deployer
 *   PLAYER2       — seat 1 (optional second seat)
 *   ROOM_ID       — on-chain room id (default 1)
 *   USDC_ADDRESS  — budget token (Base Sepolia USDC)
 *
 * Writes ./deployments/<chainId>.json.
 */
contract DeployUno is Script {
    function run() external {
        address deployer = msg.sender;
        address player = vm.envOr("PLAYER", deployer);
        address player2 = vm.envOr("PLAYER2", address(0));
        uint256 roomId = vm.envOr("ROOM_ID", uint256(1));
        address usdc = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast();

        World world = new World();
        NexusDelegationManager manager = new NexusDelegationManager();
        TurnManager tm = new TurnManager(deployer);
        RandomnessCoordinator randomness = new RandomnessCoordinator();
        UnoGameSystem game = new UnoGameSystem(address(tm));

        UnoTable.register(IWorld(address(world)));
        world.registerSystem(bytes32("UnoGame"), address(game));
        world.grantWriteAccess(UnoTable.tableId(), address(game));
        world.setTrustedForwarder(address(manager));

        game.setTrustedRouter(address(world));

        tm.authorize(address(game), true); // game may advance()
        tm.authorize(deployer, true); // deployer may seat the room
        tm.setTrustedRouter(address(world));

        address[] memory order = new address[](player2 == address(0) ? 1 : 2);
        order[0] = player;
        if (player2 != address(0)) order[1] = player2;
        tm.startTurns(roomId, order, 100000);

        // Seed the public board: top = red 5, current player holds 7 cards.
        game.startRoom(roomId, 1, 5, 7);

        TurnBoundEnforcer turnBound = new TurnBoundEnforcer();
        SystemAllowlistEnforcer systemAllowlist = new SystemAllowlistEnforcer();
        TimestampEnforcer timestamp = new TimestampEnforcer();
        LimitedCallsEnforcer limitedCalls = new LimitedCallsEnforcer();
        PerActionCapEnforcer perActionCap = new PerActionCapEnforcer();
        ERC20TransferAmountEnforcer erc20TransferAmount = new ERC20TransferAmountEnforcer();
        AllowedRecipientsEnforcer allowedRecipients = new AllowedRecipientsEnforcer();

        // The Pot collects the entry fee. settleAuthority = deployer (relayer).
        UnoPot pot = new UnoPot(IERC20(usdc), deployer, deployer, 0);

        vm.stopBroadcast();

        string memory enf = "enforcers";
        vm.serializeAddress(enf, "turnBound", address(turnBound));
        vm.serializeAddress(enf, "systemAllowlist", address(systemAllowlist));
        vm.serializeAddress(enf, "timestamp", address(timestamp));
        vm.serializeAddress(enf, "limitedCalls", address(limitedCalls));
        vm.serializeAddress(enf, "perActionCap", address(perActionCap));
        vm.serializeAddress(enf, "erc20TransferAmount", address(erc20TransferAmount));
        string memory enforcersJson =
            vm.serializeAddress(enf, "allowedRecipients", address(allowedRecipients));

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "world", address(world));
        vm.serializeAddress(root, "delegationManager", address(manager));
        vm.serializeAddress(root, "turnManager", address(tm));
        vm.serializeAddress(root, "unoGame", address(game));
        vm.serializeAddress(root, "randomness", address(randomness));
        vm.serializeBytes32(root, "unoGameSystemId", bytes32("UnoGame"));
        vm.serializeAddress(root, "usdc", usdc);
        vm.serializeAddress(root, "pot", address(pot));
        vm.serializeUint(root, "roomId", roomId);
        string memory out = vm.serializeString(root, "enforcers", enforcersJson);

        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("UNO deployed. addresses written to", path);
        console.log("World:", address(world));
        console.log("UnoGame:", address(game));
        console.log("Pot:", address(pot));
    }
}
