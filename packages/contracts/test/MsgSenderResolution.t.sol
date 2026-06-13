// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {World} from "../src/world/World.sol";
import {System} from "../src/system/System.sol";
import {MockForwarder} from "./mocks/MockForwarder.sol";

contract WhoSystem is System {
    function setTrustedRouter(address router) external {
        _setTrustedRouter(router);
    }

    function whoAmI() external view returns (address) {
        return _msgSender();
    }
}

contract MsgSenderResolutionTest is Test {
    World internal world;
    WhoSystem internal who;
    MockForwarder internal forwarder;

    bytes32 internal constant SYSTEM_ID = bytes32("WhoSystem");
    address internal player = address(0x9A1ED);

    function setUp() public {
        world = new World();
        who = new WhoSystem();
        world.registerSystem(SYSTEM_ID, address(who));
        // wire the system's trusted router to the World so it honors the appended
        // canonical sender only on the World-routed path
        who.setTrustedRouter(address(world));
        forwarder = new MockForwarder(world);
    }

    function test_DirectCall_ResolvesMsgSender() public {
        bytes memory ret = world.call(SYSTEM_ID, abi.encodeWithSignature("whoAmI()"));
        assertEq(abi.decode(ret, (address)), address(this));
    }

    function test_TrustedForwarder_ResolvesOnBehalfOf() public {
        world.setTrustedForwarder(address(forwarder));
        bytes memory ret = forwarder.redeem(SYSTEM_ID, abi.encodeWithSignature("whoAmI()"), player);
        assertEq(abi.decode(ret, (address)), player);
    }

    function test_UntrustedCaller_AppendedBytesIgnored() public {
        // forwarder is NOT set as trusted; appended onBehalfOf must be ignored,
        // so the resolved sender is the forwarder itself, not `player`.
        bytes memory ret = forwarder.redeem(SYSTEM_ID, abi.encodeWithSignature("whoAmI()"), player);
        assertEq(abi.decode(ret, (address)), address(forwarder));
    }
}
