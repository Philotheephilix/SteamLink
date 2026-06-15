// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {World} from "@nexus-contracts/world/World.sol";
import {IWorld} from "@nexus-contracts/world/IWorld.sol";
import {TurnManager} from "@nexus-contracts/systems/TurnManager.sol";
import {NexusDelegationManager} from "@nexus-contracts/delegation/NexusDelegationManager.sol";
import {TurnBoundEnforcer} from "@nexus-contracts/enforcers/TurnBoundEnforcer.sol";
import {SystemAllowlistEnforcer} from "@nexus-contracts/enforcers/SystemAllowlistEnforcer.sol";
import {TimestampEnforcer} from "@nexus-contracts/enforcers/TimestampEnforcer.sol";
import {LimitedCallsEnforcer} from "@nexus-contracts/enforcers/LimitedCallsEnforcer.sol";
import {PerActionCapEnforcer} from "@nexus-contracts/enforcers/PerActionCapEnforcer.sol";
import {ERC20TransferAmountEnforcer} from "@nexus-contracts/enforcers/ERC20TransferAmountEnforcer.sol";
import {AllowedRecipientsEnforcer} from "@nexus-contracts/enforcers/AllowedRecipientsEnforcer.sol";
import {RandomnessCoordinator} from "@nexus-contracts/randomness/RandomnessCoordinator.sol";
import {MonopolyPot} from "./MonopolyPot.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MonopolyGameSystem} from "./MonopolyGameSystem.sol";
import {PlayerTable, PropertyTable} from "./MonopolyTables.sol";

/**
 * @notice Full Nexus + Monopoly deployment for Base Sepolia (or anvil). Deploys the
 *         World + NexusDelegationManager + TurnManager + the seven caveat enforcers +
 *         RandomnessCoordinator + a Pot (the bank, escrow recipient) + the
 *         MonopolyGameSystem, wires every trust relationship, registers the Player /
 *         Property tables, registers the Monopoly system under BOTH the raw label id
 *         `bytes32("Monopoly")` AND the canonical alias id supplied via env
 *         (resourceId("monopoly","system","MonopolyGame")) so the gateway caveat
 *         sanity, the on-chain SystemAllowlistEnforcer, and World dispatch all agree.
 *
 *         The bank/pot uses canonical USDC on Base Sepolia (passed via USDC env), so
 *         real x402 charges settle a real USDC Transfer.
 *
 *         Writes addresses to examples/monopoly/deployments/base-sepolia.json.
 *
 * @dev    env:
 *           PLAYER       (address) seated as the current turn in ROOM_ID
 *           PLAYER2      (address) optional second seat
 *           ROOM_ID      (uint)    defaults to 1
 *           USDC         (address) canonical USDC for the bank/budget rails
 *           ALIAS_SYS_ID (bytes32) resourceId("monopoly","system","MonopolyGame")
 *           OUT_PATH     (string)  json output path (default base-sepolia.json)
 */
contract DeployMonopoly is Script {
    function run() external {
        address player = vm.envAddress("PLAYER");
        address player2 = vm.envOr("PLAYER2", address(0));
        uint256 roomId = vm.envOr("ROOM_ID", uint256(1));
        address usdc = vm.envAddress("USDC");
        bytes32 aliasSysId = vm.envBytes32("ALIAS_SYS_ID");
        string memory outPath = vm.envOr("OUT_PATH", string("base-sepolia.json"));

        vm.startBroadcast();

        World world = new World();
        NexusDelegationManager manager = new NexusDelegationManager();
        TurnManager tm = new TurnManager(msg.sender);
        RandomnessCoordinator rng = new RandomnessCoordinator();
        MonopolyGameSystem game = new MonopolyGameSystem(address(tm), address(rng));

        // tables
        PlayerTable.register(IWorld(address(world)));
        PropertyTable.register(IWorld(address(world)));

        // register the system under the raw label AND the canonical alias id
        world.registerSystem(bytes32("Monopoly"), address(game));
        world.registerSystem(aliasSysId, address(game));
        world.grantWriteAccess(PlayerTable.tableId(), address(game));
        world.grantWriteAccess(PropertyTable.tableId(), address(game));
        world.setTrustedForwarder(address(manager));

        game.setTrustedRouter(address(world));

        tm.authorize(address(game), true); // game may advance()
        tm.authorize(msg.sender, true); // deployer may seat
        tm.setTrustedRouter(address(world));

        // seat the room so PLAYER is the current turn
        address[] memory order = new address[](player2 == address(0) ? 1 : 2);
        order[0] = player;
        if (player2 != address(0)) order[1] = player2;
        tm.startTurns(roomId, order, 50_000);

        // enforcers
        TurnBoundEnforcer turnBound = new TurnBoundEnforcer();
        SystemAllowlistEnforcer systemAllowlist = new SystemAllowlistEnforcer();
        TimestampEnforcer timestamp = new TimestampEnforcer();
        LimitedCallsEnforcer limitedCalls = new LimitedCallsEnforcer();
        PerActionCapEnforcer perActionCap = new PerActionCapEnforcer();
        ERC20TransferAmountEnforcer erc20TransferAmount = new ERC20TransferAmountEnforcer();
        AllowedRecipientsEnforcer allowedRecipients = new AllowedRecipientsEnforcer();

        // The bank/pot: the x402 charge recipient (buy-in) + the winner payout.
        // settleAuthority = rakeCollector = deployer (the relayer) so it can open,
        // creditDeposit (mirror delegation-driven transfers), and settle to the winner.
        MonopolyPot pot = new MonopolyPot(IERC20(usdc), msg.sender, msg.sender, 0);

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
        vm.serializeAddress(root, "monopolyGame", address(game));
        vm.serializeBytes32(root, "monopolyGameSystemId", aliasSysId);
        vm.serializeAddress(root, "randomness", address(rng));
        vm.serializeAddress(root, "usdc", usdc);
        vm.serializeAddress(root, "pot", address(pot));
        vm.serializeAddress(root, "relayer", msg.sender);
        vm.serializeUint(root, "roomId", roomId);
        string memory out = vm.serializeString(root, "enforcers", enforcersJson);

        string memory path = string.concat("../deployments/", outPath);
        vm.writeJson(out, path);
        console.log("Monopoly deployed. addresses written to", path);
        console.log("World:", address(world));
        console.log("MonopolyGame:", address(game));
        console.log("RandomnessCoordinator:", address(rng));
        console.log("Pot(bank):", address(pot));
    }
}
