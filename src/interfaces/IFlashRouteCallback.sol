// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFlashRouteCallback {
    function onFlashRouteCallback(bytes32 routeId, bytes calldata data) external;
}
