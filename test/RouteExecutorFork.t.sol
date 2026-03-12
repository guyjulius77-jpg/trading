// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RouteExecutor} from "../src/RouteExecutor.sol";

interface Vm {
    function envString(string calldata key) external view returns (string memory);
    function envUint(string calldata key) external view returns (uint256);
    function createFork(string calldata urlOrAlias) external returns (uint256);
    function createFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function selectFork(uint256 forkId) external;
}

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
}

contract RouteExecutorForkTest {
    address private constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant vm = Vm(VM_ADDRESS);

    address private constant ETHEREUM_UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address private constant ETHEREUM_AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant ETHEREUM_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant ETHEREUM_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant ETHEREUM_USDC_WETH_500_POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    function testForkEthereumLiveAddressesExecuteSwapLifecycle() public {
        (bool hasForkUrl, string memory forkUrl) = _tryEnvString("FOUNDRY_FORK_URL");
        if (!hasForkUrl) return;

        uint256 forkId = _createFork(forkUrl);
        vm.selectFork(forkId);

        require(ETHEREUM_UNISWAP_ROUTER.code.length > 0, "UNISWAP_ROUTER_CODE_MISSING");
        require(ETHEREUM_USDC.code.length > 0, "USDC_CODE_MISSING");
        require(ETHEREUM_WETH.code.length > 0, "WETH_CODE_MISSING");

        RouteExecutor executor = new RouteExecutor(address(this));
        executor.setOperator(address(this), true);

        bytes32 routeId = keccak256(bytes("fork-swap-route"));
        RouteExecutor.StepPlan[] memory steps = new RouteExecutor.StepPlan[](1);
        steps[0] = RouteExecutor.StepPlan({
            stepId: keccak256(bytes("fork-step-1")),
            actionType: 1,
            poolAddress: address(0),
            routerAddress: ETHEREUM_UNISWAP_ROUTER,
            tokenIn: ETHEREUM_USDC,
            tokenOut: ETHEREUM_WETH,
            feeTier: 500,
            amountIn: 1_000_000,
            minAmountOut: 1,
            deadline: block.timestamp + 300,
            auxData: keccak256(bytes("fork-test"))
        });

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

    function testForkEthereumAavePoolHasCode() public {
        (bool hasForkUrl, string memory forkUrl) = _tryEnvString("FOUNDRY_FORK_URL");
        if (!hasForkUrl) return;

        uint256 forkId = _createFork(forkUrl);
        vm.selectFork(forkId);

        require(ETHEREUM_AAVE_V3_POOL.code.length > 0, "AAVE_POOL_CODE_MISSING");
    }

    function testForkEthereumLiveTokenMetadataAndPoolState() public {
        (bool hasForkUrl, string memory forkUrl) = _tryEnvString("FOUNDRY_FORK_URL");
        if (!hasForkUrl) return;

        uint256 forkId = _createFork(forkUrl);
        vm.selectFork(forkId);

        require(IERC20MetadataLike(ETHEREUM_USDC).decimals() == 6, "USDC_DECIMALS_UNEXPECTED");
        require(IERC20MetadataLike(ETHEREUM_WETH).decimals() == 18, "WETH_DECIMALS_UNEXPECTED");
        require(IERC20MetadataLike(ETHEREUM_USDC).totalSupply() > 1_000_000_000_000, "USDC_SUPPLY_TOO_LOW");
        require(IERC20MetadataLike(ETHEREUM_WETH).totalSupply() > 1_000 ether, "WETH_SUPPLY_TOO_LOW");

        IUniswapV3PoolLike pool = IUniswapV3PoolLike(ETHEREUM_USDC_WETH_500_POOL);
        require(address(pool).code.length > 0, "UNISWAP_POOL_CODE_MISSING");
        require(pool.token0() == ETHEREUM_USDC, "POOL_TOKEN0_UNEXPECTED");
        require(pool.token1() == ETHEREUM_WETH, "POOL_TOKEN1_UNEXPECTED");
        require(pool.fee() == 500, "POOL_FEE_UNEXPECTED");
        require(pool.liquidity() > 0, "POOL_LIQUIDITY_ZERO");
    }

    function _createFork(string memory forkUrl) internal returns (uint256 forkId) {
        (bool hasBlock, uint256 blockNumber) = _tryEnvUint("FOUNDRY_FORK_BLOCK_NUMBER");
        if (hasBlock && blockNumber > 0) {
            return vm.createFork(forkUrl, blockNumber);
        }
        return vm.createFork(forkUrl);
    }

    function _tryEnvString(string memory key) internal returns (bool ok, string memory value) {
        try vm.envString(key) returns (string memory envValue) {
            return (bytes(envValue).length > 0, envValue);
        } catch {
            return (false, "");
        }
    }

    function _tryEnvUint(string memory key) internal returns (bool ok, uint256 value) {
        try vm.envUint(key) returns (uint256 envValue) {
            return (true, envValue);
        } catch {
            return (false, 0);
        }
    }
}
