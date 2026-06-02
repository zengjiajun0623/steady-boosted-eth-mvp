// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISeriesSettlementOracle} from "./ISettlementOracle.sol";

interface IUniswapV3PoolOracleLike {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice Settlement oracle backed by a Uniswap v3-style cumulative tick TWAP.
/// @dev The oracle reads the TWAP window ending at the series maturity, not the
/// caller's settlement time. Price conversion is intentionally parameterized so
/// deployments can set token order/decimal scaling and tick safety bounds.
contract UniswapV3TwapSettlementOracle is ISeriesSettlementOracle {
    uint256 public constant WAD = 1e18;
    uint256 public constant ONE_POINT_0001_WAD = 1_000_100_000_000_000_000;

    struct SeriesConfig {
        uint64 maturity;
        uint32 twapWindow;
        bool registered;
    }

    address public immutable factory;
    IUniswapV3PoolOracleLike public immutable pool;
    uint256 public immutable priceAtTickZeroWad;
    bool public immutable invertPrice;
    int24 public immutable minUsableTick;
    int24 public immutable maxUsableTick;

    mapping(bytes32 => SeriesConfig) public seriesConfigs;

    event SeriesRegistered(bytes32 indexed seriesId, uint64 maturity, uint32 twapWindow);

    error NotFactory();
    error InvalidConfig();

    constructor(
        address factory_,
        IUniswapV3PoolOracleLike pool_,
        uint256 priceAtTickZeroWad_,
        bool invertPrice_,
        int24 minUsableTick_,
        int24 maxUsableTick_
    ) {
        if (
            factory_ == address(0) || address(pool_) == address(0) || priceAtTickZeroWad_ == 0
                || minUsableTick_ > maxUsableTick_
        ) {
            revert InvalidConfig();
        }

        factory = factory_;
        pool = pool_;
        priceAtTickZeroWad = priceAtTickZeroWad_;
        invertPrice = invertPrice_;
        minUsableTick = minUsableTick_;
        maxUsableTick = maxUsableTick_;
    }

    function registerSeries(bytes32 seriesId, uint64 maturity, uint32 twapWindow) external {
        if (msg.sender != factory) revert NotFactory();
        if (seriesId == bytes32(0) || maturity == 0 || twapWindow == 0) revert InvalidConfig();

        seriesConfigs[seriesId] = SeriesConfig({maturity: maturity, twapWindow: twapWindow, registered: true});
        emit SeriesRegistered(seriesId, maturity, twapWindow);
    }

    function settlementPrice(bytes32 seriesId) external view returns (bool settled, uint256 price) {
        SeriesConfig memory config = seriesConfigs[seriesId];
        if (!config.registered || block.timestamp < config.maturity) return (false, 0);

        uint256 secondsSinceMaturity = block.timestamp - config.maturity;
        if (secondsSinceMaturity > type(uint32).max) return (false, 0);

        uint32 secondsAgoEnd = uint32(secondsSinceMaturity);
        uint32 secondsAgoStart = secondsAgoEnd + config.twapWindow;
        if (secondsAgoStart < secondsAgoEnd) return (false, 0);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgoStart;
        secondsAgos[1] = secondsAgoEnd;

        try pool.observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s
        ) {
            secondsPerLiquidityCumulativeX128s;

            int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
            int24 averageTick = _averageTick(tickDelta, config.twapWindow);
            if (averageTick < minUsableTick || averageTick > maxUsableTick) return (false, 0);

            return (true, _priceFromTick(averageTick));
        } catch {
            return (false, 0);
        }
    }

    function _averageTick(int56 tickDelta, uint32 twapWindow) internal pure returns (int24) {
        int56 window = int56(uint56(twapWindow));
        int56 mean = tickDelta / window;
        if (tickDelta < 0 && tickDelta % window != 0) mean -= 1;
        return int24(mean);
    }

    function _priceFromTick(int24 tick) internal view returns (uint256) {
        uint256 factorWad = _pow1p0001Wad(_absTick(tick));
        if (tick < 0) factorWad = (WAD * WAD) / factorWad;

        if (invertPrice) return (priceAtTickZeroWad * WAD) / factorWad;
        return (priceAtTickZeroWad * factorWad) / WAD;
    }

    function _pow1p0001Wad(uint256 exponent) internal pure returns (uint256 result) {
        result = WAD;
        uint256 base = ONE_POINT_0001_WAD;

        while (exponent != 0) {
            if (exponent & 1 != 0) result = (result * base) / WAD;
            exponent >>= 1;
            if (exponent != 0) base = (base * base) / WAD;
        }
    }

    function _absTick(int24 tick) internal pure returns (uint256) {
        return tick < 0 ? uint256(uint24(-tick)) : uint256(uint24(tick));
    }
}
