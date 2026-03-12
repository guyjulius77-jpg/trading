// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "../FlashExecutor.sol";

contract AaveReceiver is FlashExecutor {
    struct AaveExecutionParams {
        bytes32 routeId;
        address repaymentAsset;
        uint256 principal;
        uint256 amountOwed;
    }

    address public aavePool;

    constructor(address initialOwner, address pool) FlashExecutor(initialOwner) {
        aavePool = pool;
    }

    function setAavePool(address pool) external onlyOwner {
        aavePool = pool;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "INVALID_CALLER");

        AaveExecutionParams memory decoded = abi.decode(params, (AaveExecutionParams));
        require(contexts[decoded.routeId].active, "INACTIVE_ROUTE");

        address repaymentAsset = decoded.repaymentAsset == address(0) ? asset : decoded.repaymentAsset;
        uint256 principal = decoded.principal == 0 ? amount : decoded.principal;
        uint256 amountOwed = decoded.amountOwed == 0 ? amount + premium : decoded.amountOwed;

        _setRepaymentExpectation(decoded.routeId, repaymentAsset, principal, amountOwed);
        emit StepExecuted(decoded.routeId, keccak256("AAVE_EXECUTE_OPERATION"), initiator == address(0) ? "noop" : "execute_operation");
        emit RepaymentAsserted(decoded.routeId, repaymentAsset, amountOwed);
        return true;
    }
}
