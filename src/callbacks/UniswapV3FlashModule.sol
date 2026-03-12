// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "../FlashExecutor.sol";

contract UniswapV3FlashModule is FlashExecutor {
    mapping(address => bool) public allowedPools;

    constructor(address initialOwner) FlashExecutor(initialOwner) {}

    function setPool(address pool, bool allowed) external onlyOwner {
        allowedPools[pool] = allowed;
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        require(allowedPools[msg.sender], "INVALID_POOL");
        bytes32 routeId = keccak256(data);
        emit StepExecuted(routeId, keccak256("UNISWAP_V3_FLASH_CALLBACK"), "uniswap_v3_flash_callback");
        emit RepaymentAsserted(routeId, address(0), fee0 + fee1);
    }
}
