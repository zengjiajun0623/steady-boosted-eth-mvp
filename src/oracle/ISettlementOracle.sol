// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISettlementOracle {
    /// @notice Returns the ETH/stable settlement price with 18 decimals for a matured series.
    function settlementPrice(bytes32 seriesId) external view returns (bool settled, uint256 price);
}

interface ISeriesSettlementOracle is ISettlementOracle {
    /// @notice Factory hook that binds series metadata used by maturity-anchored settlement.
    function registerSeries(bytes32 seriesId, uint64 maturity, uint32 twapWindow) external;
}
