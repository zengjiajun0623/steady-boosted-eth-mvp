// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISeriesSettlementOracle} from "./ISettlementOracle.sol";

contract MockSettlementOracle is ISeriesSettlementOracle {
    struct Price {
        bool settled;
        uint256 value;
    }

    struct SeriesConfig {
        uint64 maturity;
        uint32 twapWindow;
        bool registered;
    }

    mapping(bytes32 => Price) public prices;
    mapping(bytes32 => SeriesConfig) public seriesConfigs;

    event SeriesRegistered(bytes32 indexed seriesId, uint64 maturity, uint32 twapWindow);

    error InvalidConfig();

    function registerSeries(bytes32 seriesId, uint64 maturity, uint32 twapWindow) external {
        if (seriesId == bytes32(0) || maturity == 0 || twapWindow == 0) revert InvalidConfig();

        seriesConfigs[seriesId] = SeriesConfig({maturity: maturity, twapWindow: twapWindow, registered: true});
        emit SeriesRegistered(seriesId, maturity, twapWindow);
    }

    function setSettlementPrice(bytes32 seriesId, uint256 price) external {
        prices[seriesId] = Price({settled: true, value: price});
    }

    function clearSettlementPrice(bytes32 seriesId) external {
        delete prices[seriesId];
    }

    function settlementPrice(bytes32 seriesId) external view returns (bool settled, uint256 price) {
        Price memory p = prices[seriesId];
        return (p.settled, p.value);
    }
}
