// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashExecutor} from "./FlashExecutor.sol";

contract RouteExecutor is FlashExecutor {
    struct StepPlan {
        bytes32 stepId;
        uint8 actionType;
        address poolAddress;
        address routerAddress;
        address tokenIn;
        address tokenOut;
        uint24 feeTier;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        bytes32 auxData;
    }

    struct AtomicAavePlan {
        bytes32 routeId;
        address repaymentAsset;
        uint256 principal;
        uint256 amountOwed;
        uint256 deadline;
        address aavePool;
        address receiver;
        address borrowAsset;
        uint256 borrowAmount;
        StepPlan[] swapSteps;
    }

    struct SwapPlan {
        bytes32 routeId;
        uint256 deadline;
        bool atomic;
        StepPlan[] swapSteps;
    }

    struct AtomicDydxPlan {
        bytes32 routeId;
        address repaymentAsset;
        uint256 principal;
        uint256 amountOwed;
        uint256 deadline;
        address soloMargin;
        uint256 marketId;
        address borrowAsset;
        uint256 borrowAmount;
        StepPlan[] swapSteps;
    }

    event PlanDecoded(bytes32 indexed routeId, string planKind, uint256 stepCount, address primaryTarget);
    event StepPlanDecoded(
        bytes32 indexed routeId,
        bytes32 indexed stepId,
        uint8 actionType,
        address routerAddress,
        address poolAddress,
        bytes32 auxData
    );

    constructor(address initialOwner) FlashExecutor(initialOwner) {}

    function prepareAtomicCycle(
        bytes32 routeId,
        address repaymentAsset,
        uint256 principal,
        uint256 amountOwed,
        uint256 deadline
    ) external onlyOperator {
        beginExecution(routeId, deadline, true);
        _setRepaymentExpectation(routeId, repaymentAsset, principal, amountOwed);
    }

    function executeComposableRoute(bytes32 routeId, bytes32[] calldata stepIds, string[] calldata actions) external onlyOperator {
        require(stepIds.length == actions.length, "LENGTH_MISMATCH");
        _assertDeadline(routeId);
        for (uint256 i = 0; i < stepIds.length; i++) {
            emit StepExecuted(routeId, stepIds[i], actions[i]);
        }
    }

    function executeAtomicAavePlan(bytes calldata encodedPlan) external onlyOperator {
        AtomicAavePlan memory plan = abi.decode(encodedPlan, (AtomicAavePlan));
        beginExecution(plan.routeId, plan.deadline, true);
        _setRepaymentExpectation(plan.routeId, plan.repaymentAsset, plan.principal, plan.amountOwed);

        emit PlanDecoded(plan.routeId, "atomic_aave", plan.swapSteps.length, plan.aavePool);
        emit StepExecuted(plan.routeId, keccak256(bytes("FLASH_BORROW")), "flash_borrow");
        _emitStepPlans(plan.routeId, plan.swapSteps);
        emit RepaymentAsserted(plan.routeId, plan.repaymentAsset, plan.amountOwed);
        _finish(plan.routeId);
    }

    function executeSwapPlan(bytes calldata encodedPlan) external onlyOperator {
        SwapPlan memory plan = abi.decode(encodedPlan, (SwapPlan));
        beginExecution(plan.routeId, plan.deadline, plan.atomic);

        emit PlanDecoded(plan.routeId, "swap_plan", plan.swapSteps.length, address(0));
        _emitStepPlans(plan.routeId, plan.swapSteps);
        _finish(plan.routeId);
    }

    function executeAtomicDydxPlan(bytes calldata encodedPlan) external onlyOperator {
        AtomicDydxPlan memory plan = abi.decode(encodedPlan, (AtomicDydxPlan));
        beginExecution(plan.routeId, plan.deadline, true);
        _setRepaymentExpectation(plan.routeId, plan.repaymentAsset, plan.principal, plan.amountOwed);

        emit PlanDecoded(plan.routeId, "atomic_dydx", plan.swapSteps.length, plan.soloMargin);
        emit StepExecuted(plan.routeId, keccak256(bytes("DYDX_OPERATE")), "operate");
        _emitStepPlans(plan.routeId, plan.swapSteps);
        emit RepaymentAsserted(plan.routeId, plan.repaymentAsset, plan.amountOwed);
        _finish(plan.routeId);
    }

    function _emitStepPlans(bytes32 routeId, StepPlan[] memory steps) internal {
        for (uint256 i = 0; i < steps.length; i++) {
            StepPlan memory step = steps[i];
            _assertDeadline(routeId);
            emit StepPlanDecoded(routeId, step.stepId, step.actionType, step.routerAddress, step.poolAddress, step.auxData);

            if (step.tokenIn != address(0) || step.tokenOut != address(0)) {
                emit SwapStepPrepared(routeId, step.stepId, step.tokenIn, step.tokenOut, step.feeTier, step.poolAddress);
            }

            emit StepExecuted(routeId, step.stepId, _actionLabel(step.actionType));
        }
    }

    function _finish(bytes32 routeId) internal {
        require(contexts[routeId].active, "INACTIVE_ROUTE");
        delete contexts[routeId];
        emit ExecutionFinished(routeId);
    }

    function _actionLabel(uint8 actionType) internal pure returns (string memory) {
        if (actionType == 1) return "exact_input_single";
        if (actionType == 2) return "stable_swap";
        if (actionType == 3) return "route_processor";
        if (actionType == 4) return "operate";
        if (actionType == 5) return "flash_borrow";
        if (actionType == 6) return "repay_flash_loan";
        return "swap";
    }
}
