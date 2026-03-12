// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "../FlashExecutor.sol";

contract PancakeFlashModule is FlashExecutor {
    mapping(address => bool) public allowedPairs;

    constructor(address initialOwner) FlashExecutor(initialOwner) {}

    function setPair(address pair, bool allowed) external onlyOwner {
        allowedPairs[pair] = allowed;
    }

    function pancakeCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        require(allowedPairs[msg.sender], "INVALID_PAIR");
        bytes32 routeId = keccak256(data);
        emit StepExecuted(routeId, keccak256("PANCAKE_CALL"), sender == address(0) ? "noop" : "pancake_call");
        emit RepaymentAsserted(routeId, address(0), amount0 + amount1);
    }
}
