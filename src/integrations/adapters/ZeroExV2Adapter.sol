// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.8;
pragma experimental ABIEncoderV2;

import "../interfaces/IZeroExV2.sol";
import "../libs/OrderTaker.sol";

/// @title ZeroExV2Adapter Contract
/// @author Melon Council DAO <security@meloncoucil.io>
/// @notice Adapter to 0xV2 Exchange Contract
contract ZeroExV2Adapter is OrderTaker {
    address immutable public EXCHANGE;

    constructor(address _exchange) public {
        EXCHANGE = _exchange;
    }

    /// @notice Provides a constant string identifier for an adapter
    /// @return An identifier string
    function identifier() external pure override returns (string memory) {
        return "ZERO_EX_V2";
    }

    /// @notice Parses the expected assets to receive from a call on integration 
    /// @param _selector The function selector for the callOnIntegration
    /// @param _encodedArgs The encoded parameters for the callOnIntegration
    /// @return incomingAssets_ The assets to receive
    function parseIncomingAssets(bytes4 _selector, bytes calldata _encodedArgs)
        external
        view
        override
        returns (address[] memory incomingAssets_)
    {
        if (_selector == TAKE_ORDER_SELECTOR) {
            (,,bytes[2] memory orderData,) = __decodeTakeOrderArgs(_encodedArgs);

            incomingAssets_ = new address[](1);
            incomingAssets_[0] = __getAssetAddress(orderData[0]);
        }
        else {
            revert("parseIncomingAssets: _selector invalid");
        }
    }

    /// @notice Takes an active order on 0x v2 (takeOrder)
    /// @param _encodedArgs Encoded parameters passed from client side
    /// @param _fillData Encoded data to pass to OrderFiller
    function __fillTakeOrder(bytes memory _encodedArgs, bytes memory _fillData)
        internal
        override
        validateAndFinalizeFilledOrder(_fillData)
    {
        (
            address[4] memory orderAddresses,
            uint256[7] memory orderValues,
            bytes[2] memory orderData,
            bytes memory signature
        ) = __decodeTakeOrderArgs(_encodedArgs);

        (,uint256[] memory fillExpectedAmounts,) = __decodeOrderFillData(_fillData);

        // Execute take order on exchange
        IZeroExV2(EXCHANGE).fillOrder(
            __constructOrderStruct(orderAddresses, orderValues, orderData),
            fillExpectedAmounts[1],
            signature
        );
    }

    /// @notice Formats arrays of _fillAssets and their _fillExpectedAmounts for a takeOrder call
    /// @param _encodedArgs Encoded parameters passed from client side
    /// @return fillAssets_ Assets to fill
    /// - [0] Maker asset (same as _orderAddresses[2])
    /// - [1] Taker asset (same as _orderAddresses[3])
    /// - [2] Taker Fee asset (ZRX)
    /// @return fillExpectedAmounts_ Asset fill amounts
    /// - [0] Expected (min) quantity of maker asset to receive
    /// - [1] Expected (max) quantity of taker asset to spend
    /// - [2] Expected (max) quantity of taker fee asset (ZRX) to spend
    /// @return fillApprovalTargets_ Recipients of assets in fill order
    /// - [0] Taker (fund), set to address(0)
    /// - [1] 0x asset proxy for the taker asset
    /// - [2] 0x asset proxy for the taker fee asset (ZRX)
    function __formatFillTakeOrderArgs(bytes memory _encodedArgs)
        internal
        view
        override
        returns (address[] memory, uint256[] memory, address[] memory)
    {
        (
            address[4] memory orderAddresses,
            uint256[7] memory orderValues,
            bytes[2] memory orderData,
        ) = __decodeTakeOrderArgs(_encodedArgs);

        address[] memory fillAssets = new address[](3);
        fillAssets[0] = __getAssetAddress(orderData[0]); // maker asset
        fillAssets[1] = __getAssetAddress(orderData[1]); // taker asset
        fillAssets[2] = __getAssetAddress(IZeroExV2(EXCHANGE).ZRX_ASSET_DATA()); // taker fee asset

        uint256[] memory fillExpectedAmounts = new uint256[](3);
        fillExpectedAmounts[0] = __calculateRelativeQuantity(
            orderValues[1],
            orderValues[0],
            orderValues[6]
        ); // maker fill amount; calculated relative to taker fill amount
        fillExpectedAmounts[1] = orderValues[6]; // taker fill amount
        fillExpectedAmounts[2] = __calculateRelativeQuantity(
            orderValues[1],
            orderValues[3],
            orderValues[6]
        ); // taker fee amount; calculated relative to taker fill amount

        address[] memory fillApprovalTargets = new address[](3);
        fillApprovalTargets[0] = address(0); // Fund (Use 0x0)
        // 0x asset proxy for taker asset
        fillApprovalTargets[1] = __getAssetProxy(orderData[1]);
        // 0x asset proxy for taker fee asset (ZRX)
        fillApprovalTargets[2] = __getAssetProxy(IZeroExV2(EXCHANGE).ZRX_ASSET_DATA());

        return (fillAssets, fillExpectedAmounts, fillApprovalTargets);
    }

    /// @notice Validate the parameters of a takeOrder call
    /// @param _encodedArgs Encoded parameters passed from client side
    function __validateTakeOrderParams(bytes memory _encodedArgs)
        internal
        view
        override
    {
        (,uint256[7] memory orderValues,,) = __decodeTakeOrderArgs(_encodedArgs);

        require(
            orderValues[6] <= orderValues[1],
            "__validateTakeOrderParams: taker fill amount greater than max order quantity"
        );
    }

    // PRIVATE FUNCTIONS

    /// @notice Parses user inputs into a ZeroExV2.Order format
    function __constructOrderStruct(
        address[4] memory _orderAddresses,
        uint256[7] memory _orderValues,
        bytes[2] memory _orderData
    )
        private
        pure
        returns (IZeroExV2.Order memory order)
    {
        order = IZeroExV2.Order({
            makerAddress: _orderAddresses[0],
            takerAddress: _orderAddresses[1],
            feeRecipientAddress: _orderAddresses[2],
            senderAddress: _orderAddresses[3],
            makerAssetAmount: _orderValues[0],
            takerAssetAmount: _orderValues[1],
            makerFee: _orderValues[2],
            takerFee: _orderValues[3],
            expirationTimeSeconds: _orderValues[4],
            salt: _orderValues[5],
            makerAssetData: _orderData[0],
            takerAssetData: _orderData[1]
        });
    }

    /// @notice Gets the 0x assetProxy address for an ERC20 token
    function __getAssetProxy(bytes memory _assetData)
        private
        view
        returns (address assetProxy_)
    {
        bytes4 assetProxyId;
        assembly {
            assetProxyId := and(mload(
                add(_assetData, 32)),
                0xFFFFFFFF00000000000000000000000000000000000000000000000000000000
            )
        }
        assetProxy_ = IZeroExV2(EXCHANGE).getAssetProxy(assetProxyId);
    }

    /// @notice Parses the asset address from 0x assetData
    function __getAssetAddress(bytes memory _assetData)
        private
        view
        returns (address assetAddress_)
    {
        assembly {
            assetAddress_ := mload(add(_assetData, 36))
        }
    }

    /// @notice Decode the parameters of a takeOrder call
    /// @param _encodedArgs Encoded parameters passed from client side
    /// @return orderAddresses_ needed addresses for an exchange to take an order
    /// - [0] 0x Order param: makerAddress
    /// - [1] 0x Order param: takerAddress
    /// - [2] 0x Order param: feeRecipientAddress
    /// - [3] 0x Order param: senderAddress
    /// @return orderValues_ needed values for an exchange to take an order
    /// - [0] 0x Order param: makerAssetAmount
    /// - [1] 0x Order param: takerAssetAmount
    /// - [2] 0x Order param: makerFee
    /// - [3] 0x Order param: takerFee
    /// - [4] 0x Order param: expirationTimeSeconds
    /// - [5] 0x Order param: salt
    /// - [6] Taker asset fill quantity
    /// @return orderData_ Need data for an exchange to take an order
    /// - [0] 0x Order param: makerAssetData
    /// - [1] 0x Order param: takerAssetData
    /// @return signature_ Signature of the order
    function __decodeTakeOrderArgs(
        bytes memory _encodedArgs
    )
        internal
        pure
        returns (
            address[4] memory orderAddresses_,
            uint256[7] memory orderValues_,
            bytes[2] memory orderData_,
            bytes memory signature_
        )
    {
        return abi.decode(
            _encodedArgs,
            (
                address[4],
                uint256[7],
                bytes[2],
                bytes
            )
        );
    }
}
