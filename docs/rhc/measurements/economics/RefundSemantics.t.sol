// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";

contract Slot {
    uint256 public x;
    function setAndClear() external { x = 1; x = 0; } // cold 0->1 costs 22 100, 1->0 costs 100 and refunds 19 900
    function setOnly() external { x = 1; }            // cold 0->1 costs 22 100, no refund
}

/// Is vm.lastCallGas().gasTotalUsed gross or net of the refund counter?
contract RefundSemanticsTest is Test {
    function test_GasTotalUsedIsNetOfRefund() public {
        Slot a = new Slot();
        Slot b = new Slot();
        a.setAndClear();
        Vm.Gas memory ga = vm.lastCallGas();
        b.setOnly();
        Vm.Gas memory gb = vm.lastCallGas();
        emit log_named_uint("setAndClear gasTotalUsed", ga.gasTotalUsed);
        emit log_named_int("setAndClear gasRefunded", ga.gasRefunded);
        emit log_named_uint("setOnly gasTotalUsed", gb.gasTotalUsed);
        emit log_named_int("setOnly gasRefunded", gb.gasRefunded);
    }
}
