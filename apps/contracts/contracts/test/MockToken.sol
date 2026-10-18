//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal token for local tests of the token gate (balances only). Not for deployment.
contract MockToken {
    string public constant symbol = "MOCK";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
