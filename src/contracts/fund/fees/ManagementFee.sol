pragma solidity ^0.4.21;

import "Fee.i.sol";
import "FeeManager.sol";
import "Accounting.sol";
import "Hub.sol";
import "Shares.sol";
import "math.sol";

contract ManagementFee is DSMath, Fee {

    uint public DIVISOR = 10 ** 18;

    mapping (address => uint) public managementFeeRate;
    mapping (address => uint) public lastPayoutTime;

    function feeAmount() public view returns (uint feeInShares) {
        Hub hub = FeeManager(msg.sender).hub();
        Accounting accounting = Accounting(hub.accounting());
        Shares shares = Shares(hub.shares());
        if (shares.totalSupply() == 0) {
            feeInShares = 0;
        } else {
            uint timePassed = sub(block.timestamp, lastPayoutTime[msg.sender]);
            uint preDilutionFeeShares = mul(mul(shares.totalSupply(), managementFeeRate[msg.sender]) / DIVISOR, timePassed) / 1 years;
            feeInShares =
                mul(preDilutionFeeShares, shares.totalSupply()) /
                sub(shares.totalSupply(), preDilutionFeeShares);
        }
        return feeInShares;
    }

    function initializeForUser(uint feeRate, uint feePeriod) external {
        require(lastPayoutTime[msg.sender] == 0);
        managementFeeRate[msg.sender] = feeRate;
        lastPayoutTime[msg.sender] = block.timestamp;
    }

    function updateState() external {
        lastPayoutTime[msg.sender] = block.timestamp;
    }
}
