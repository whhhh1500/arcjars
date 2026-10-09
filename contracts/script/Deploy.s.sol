// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ArcJarFactory} from "../src/ArcJarFactory.sol";

/// @notice Deploys {ArcJarFactory} (which deploys the {ArcJar} implementation).
/// Env: FEE_RECIPIENT (required), FEE_BPS (default 20 = 0.2 %, max 20).
contract Deploy is Script {
    function run() external returns (ArcJarFactory factory) {
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(20)));
        vm.startBroadcast();
        factory = new ArcJarFactory(feeRecipient, feeBps);
        vm.stopBroadcast();
        console2.log("ArcJarFactory:", address(factory));
        console2.log("ArcJar implementation:", address(factory.implementation()));
        console2.log("feeRecipient:", feeRecipient);
        console2.log("feeBps:", feeBps);
    }
}
