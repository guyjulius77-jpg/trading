// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessController} from "./AccessController.sol";

contract FlashExecutor is AccessController {
    struct ExecutionContext {
        bytes32 routeId;
        address initiator;
        address repaymentAsset;
        uint256 principal;
        uint256 amountOwed;
        uint256 deadline;
        bool atomic;
        bool active;
    }

    mapping(bytes32 => ExecutionContext) public contexts;

    event ExecutionStarted(bytes32 indexed routeId, address indexed initiator, uint256 deadline, bool atomic);
    event StepExecuted(bytes32 indexed routeId, bytes32 indexed stepId, string action);
    event SwapStepPrepared(
        bytes32 indexed routeId,
        bytes32 indexed stepId,
        address indexed tokenIn,
        address tokenOut,
        uint24 feeTier,
        address pool
    );
    event RepaymentExpectationSet(bytes32 indexed routeId, address indexed asset, uint256 principal, uint256 amountOwed);
    event RepaymentAsserted(bytes32 indexed routeId, address indexed asset, uint256 amountOwed);
    event ExecutionFinished(bytes32 indexed routeId);

    constructor(address initialOwner) AccessController(initialOwner) {}

    function beginExecution(bytes32 routeId, uint256 deadline, bool atomic) public onlyOperator {
        require(routeId != bytes32(0), "ZERO_ROUTE");
        require(deadline >= block.timestamp, "DEADLINE_EXPIRED");
        contexts[routeId] = ExecutionContext({
            routeId: routeId,
            initiator: msg.sender,
            repaymentAsset: address(0),
            principal: 0,
            amountOwed: 0,
            deadline: deadline,
            atomic: atomic,
            active: true
        });
        emit ExecutionStarted(routeId, msg.sender, deadline, atomic);
    }

    function emitStep(bytes32 routeId, bytes32 stepId, string calldata action) external onlyOperator {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        _assertDeadline(routeId);
        emit StepExecuted(routeId, stepId, action);
    }

    function emitSwapStep(
        bytes32 routeId,
        bytes32 stepId,
        address tokenIn,
        address tokenOut,
        uint24 feeTier,
        address pool
    ) external onlyOperator {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        _assertDeadline(routeId);
        emit SwapStepPrepared(routeId, stepId, tokenIn, tokenOut, feeTier, pool);
        emit StepExecuted(routeId, stepId, "swap_prepared");
    }

    function setRepaymentExpectation(bytes32 routeId, address asset, uint256 principal, uint256 amountOwed) external onlyOperator {
        _setRepaymentExpectation(routeId, asset, principal, amountOwed);
    }

    function assertRepayment(bytes32 routeId, address asset, uint256 amountOwed) external onlyOperator {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        _assertDeadline(routeId);
        emit RepaymentAsserted(routeId, asset, amountOwed);
    }

    function finishExecution(bytes32 routeId) external onlyOperator {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        delete contexts[routeId];
        emit ExecutionFinished(routeId);
    }

    function _setRepaymentExpectation(bytes32 routeId, address asset, uint256 principal, uint256 amountOwed) internal {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        contexts[routeId].repaymentAsset = asset;
        contexts[routeId].principal = principal;
        contexts[routeId].amountOwed = amountOwed;
        emit RepaymentExpectationSet(routeId, asset, principal, amountOwed);
    }

    function _assertDeadline(bytes32 routeId) internal view {
        require(block.timestamp <= contexts[routeId].deadline, "DEADLINE_EXPIRED");
    }
}
