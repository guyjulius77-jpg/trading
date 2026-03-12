// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "../FlashExecutor.sol";

contract BentoBoxFlashModule is FlashExecutor {
    address public bentoBox;

    constructor(address initialOwner, address bentoBox_) FlashExecutor(initialOwner) {
        bentoBox = bentoBox_;
    }

    function setBentoBox(address bentoBox_) external onlyOwner {
        bentoBox = bentoBox_;
    }

    function onBentoBoxFlashLoan(address token, uint256 amount, uint256 fee, bytes calldata data) external {
        require(msg.sender == bentoBox, "INVALID_BENTOBOX");
        bytes32 routeId = keccak256(data);
        emit StepExecuted(routeId, keccak256("BENTOBOX_FLASH"), "bentobox_flash");
        emit RepaymentAsserted(routeId, token, amount + fee);
    }
}
