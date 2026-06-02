// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISeriesSettlementOracle} from "./ISettlementOracle.sol";
import {IUniswapV3PoolOracleLike} from "./UniswapV3TwapSettlementOracle.sol";

/// @notice ETH settlement oracle using the median of three stablecoin/WETH Uniswap v3 TWAPs.
/// @dev Each pool can use its own token order, decimal scaling, and tick safety band.
/// The oracle reads the TWAP window ending at maturity and requires all three
/// configured pools to be ready so one depegged stable cannot set settlement.
contract MedianStableTwapSettlementOracle is ISeriesSettlementOracle {
    uint256 public constant WAD = 1e18;
    uint256 public constant ONE_POINT_0001_WAD = 1_000_100_000_000_000_000;
    uint256 public constant SOURCE_COUNT = 3;

    struct PoolConfig {
        IUniswapV3PoolOracleLike pool;
        uint256 priceAtTickZeroWad;
        bool invertPrice;
        int24 minUsableTick;
        int24 maxUsableTick;
    }

    struct SeriesConfig {
        uint64 maturity;
        uint32 twapWindow;
        bool registered;
    }

    address public immutable factory;
    PoolConfig[3] public poolConfigs;

    mapping(bytes32 => SeriesConfig) public seriesConfigs;

    event SeriesRegistered(bytes32 indexed seriesId, uint64 maturity, uint32 twapWindow);

    error NotFactory();
    error InvalidConfig();

    constructor(address factory_, PoolConfig[3] memory poolConfigs_) {
        if (factory_ == address(0)) revert InvalidConfig();
        factory = factory_;

        for (uint256 i = 0; i < SOURCE_COUNT; i += 1) {
            PoolConfig memory config = poolConfigs_[i];
            if (
                address(config.pool) == address(0) || config.priceAtTickZeroWad == 0
                    || config.minUsableTick > config.maxUsableTick
            ) {
                revert InvalidConfig();
            }
            poolConfigs[i] = config;
        }
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

        uint256[3] memory prices;
        for (uint256 i = 0; i < SOURCE_COUNT; i += 1) {
            (bool ready, uint256 sourcePrice) =
                _sourceSettlementPrice(poolConfigs[i], secondsAgoStart, secondsAgoEnd, config.twapWindow);
            if (!ready || sourcePrice == 0) return (false, 0);
            prices[i] = sourcePrice;
        }

        return (true, _median(prices[0], prices[1], prices[2]));
    }

    function _sourceSettlementPrice(
        PoolConfig memory config,
        uint32 secondsAgoStart,
        uint32 secondsAgoEnd,
        uint32 twapWindow
    ) internal view returns (bool ready, uint256 price) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgoStart;
        secondsAgos[1] = secondsAgoEnd;

        try config.pool.observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s
        ) {
            secondsPerLiquidityCumulativeX128s;

            int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
            int24 averageTick = _averageTick(tickDelta, twapWindow);
            if (averageTick < config.minUsableTick || averageTick > config.maxUsableTick) return (false, 0);

            return (true, _priceFromTick(config, averageTick));
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

    function _priceFromTick(PoolConfig memory config, int24 tick) internal pure returns (uint256) {
        uint256 factorWad = _pow1p0001Wad(_absTick(tick));
        if (tick < 0) factorWad = (WAD * WAD) / factorWad;

        if (config.invertPrice) return (config.priceAtTickZeroWad * WAD) / factorWad;
        return (config.priceAtTickZeroWad * factorWad) / WAD;
    }

    function _median(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 temp;
        if (a > b) {
            temp = a;
            a = b;
            b = temp;
        }
        if (b > c) {
            temp = b;
            b = c;
            c = temp;
        }
        if (a > b) {
            b = a;
        }
        return b;
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
