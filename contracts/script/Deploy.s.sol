// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PulseAutomation.sol";

/// Usage:
///   EXECUTOR_ADDRESS=0x... forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external returns (PulseAutomation pulse) {
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        require(executor != address(0), "EXECUTOR_ADDRESS not set");

        vm.startBroadcast();
        pulse = new PulseAutomation(executor);
        vm.stopBroadcast();

        console2.log("PulseAutomation deployed at:", address(pulse));
        console2.log("owner:", pulse.owner());
        console2.log("executor:", pulse.executor());
    }
}
