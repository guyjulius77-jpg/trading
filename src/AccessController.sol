// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AccessController {
    address public owner;
    mapping(address => bool) public operators;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorSet(address indexed operator, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "NOT_OPERATOR");
        _;
    }

    constructor(address initialOwner) {
        require(initialOwner != address(0), "ZERO_OWNER");
        owner = initialOwner;
        emit OwnerTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }
}
