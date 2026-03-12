// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "../FlashExecutor.sol";

contract SoloMarginWrapper is FlashExecutor {
    address public soloMargin;

    constructor(address initialOwner, address soloMargin_) FlashExecutor(initialOwner) {
        soloMargin = soloMargin_;
    }

    function setSoloMargin(address soloMargin_) external onlyOwner {
        soloMargin = soloMargin_;
    }

    function callFunction(address sender, bytes calldata accountInfo, bytes calldata data) external {
        require(msg.sender == soloMargin, "INVALID_SOLO_MARGIN");
        bytes32 routeId = keccak256(data);
        emit StepExecuted(routeId, keccak256("SOLO_MARGIN_CALL"), sender == address(0) ? "noop" : "call_function");
        emit StepExecuted(routeId, keccak256(accountInfo), "account_info_received");
    }
}
