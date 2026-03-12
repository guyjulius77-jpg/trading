// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RouteExecutor} from "../src/RouteExecutor.sol";

contract RouteExecutorTest {
    function testExecuteSwapPlanCompletesLifecycle() public {
        RouteExecutor executor = _deploy();
        bytes32 routeId = keccak256(bytes("swap-route"));

        RouteExecutor.StepPlan[] memory steps = new RouteExecutor.StepPlan[](1);
        steps[0] = _stepPlan();

        RouteExecutor.SwapPlan memory plan = RouteExecutor.SwapPlan({
            routeId: routeId,
            deadline: block.timestamp + 300,
            atomic: false,
            swapSteps: steps
        });

        executor.executeSwapPlan(abi.encode(plan));

        (, , , , , , , bool active) = executor.contexts(routeId);
        require(!active, "ROUTE_STILL_ACTIVE");
    }

    function testExecuteAtomicAavePlanCompletesLifecycle() public {
        RouteExecutor executor = _deploy();
        bytes32 routeId = keccak256(bytes("aave-route"));

        RouteExecutor.StepPlan[] memory steps = new RouteExecutor.StepPlan[](1);
        steps[0] = _stepPlan();

        RouteExecutor.AtomicAavePlan memory plan = RouteExecutor.AtomicAavePlan({
            routeId: routeId,
            repaymentAsset: address(0x1000000000000000000000000000000000000001),
            principal: 1_000_000,
            amountOwed: 1_000_500,
            deadline: block.timestamp + 300,
            aavePool: address(0x2000000000000000000000000000000000000002),
            receiver: address(0x3000000000000000000000000000000000000003),
            borrowAsset: address(0x1000000000000000000000000000000000000001),
            borrowAmount: 1_000_000,
            swapSteps: steps
        });

        executor.executeAtomicAavePlan(abi.encode(plan));

        (, , , , , , , bool active) = executor.contexts(routeId);
        require(!active, "ROUTE_STILL_ACTIVE");
    }

    function testExecuteAtomicDydxPlanCompletesLifecycle() public {
        RouteExecutor executor = _deploy();
        bytes32 routeId = keccak256(bytes("dydx-route"));

        RouteExecutor.StepPlan[] memory steps = new RouteExecutor.StepPlan[](1);
        steps[0] = _stepPlan();

        RouteExecutor.AtomicDydxPlan memory plan = RouteExecutor.AtomicDydxPlan({
            routeId: routeId,
            repaymentAsset: address(0x1000000000000000000000000000000000000001),
            principal: 1_000_000,
            amountOwed: 1_000_500,
            deadline: block.timestamp + 300,
            soloMargin: address(0x4000000000000000000000000000000000000004),
            marketId: 2,
            borrowAsset: address(0x1000000000000000000000000000000000000001),
            borrowAmount: 1_000_000,
            swapSteps: steps
        });

        executor.executeAtomicDydxPlan(abi.encode(plan));

        (, , , , , , , bool active) = executor.contexts(routeId);
        require(!active, "ROUTE_STILL_ACTIVE");
    }

    function testRevertsExpiredDeadline() public {
        RouteExecutor executor = _deploy();
        bytes32 routeId = keccak256(bytes("expired-route"));

        RouteExecutor.StepPlan[] memory steps = new RouteExecutor.StepPlan[](1);
        steps[0] = _stepPlan();

        RouteExecutor.SwapPlan memory plan = RouteExecutor.SwapPlan({
            routeId: routeId,
            deadline: block.timestamp - 1,
            atomic: false,
            swapSteps: steps
        });

        (bool ok, ) = address(executor).call(abi.encodeWithSelector(RouteExecutor.executeSwapPlan.selector, abi.encode(plan)));
        require(!ok, "EXPECTED_REVERT");
    }

    function _deploy() internal returns (RouteExecutor executor) {
        executor = new RouteExecutor(address(this));
        executor.setOperator(address(this), true);
    }

    function _stepPlan() internal view returns (RouteExecutor.StepPlan memory) {
        return RouteExecutor.StepPlan({
            stepId: keccak256(bytes("step-1")),
            actionType: 1,
            poolAddress: address(0x5000000000000000000000000000000000000005),
            routerAddress: address(0x6000000000000000000000000000000000000006),
            tokenIn: address(0x7000000000000000000000000000000000000007),
            tokenOut: address(0x8000000000000000000000000000000000000008),
            feeTier: 500,
            amountIn: 1_000_000,
            minAmountOut: 990_000,
            deadline: block.timestamp + 300,
            auxData: keccak256(bytes("unit-test"))
        });
    }
}
