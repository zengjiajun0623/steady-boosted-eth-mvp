// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {MedianStableTwapSettlementOracle} from "../src/oracle/MedianStableTwapSettlementOracle.sol";
import {IUniswapV3PoolOracleLike} from "../src/oracle/UniswapV3TwapSettlementOracle.sol";

interface MedianOracleVm {
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract MockMedianUniswapV3PoolOracle {
    int24 public tick;
    bool public shouldRevert;

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (shouldRevert) revert("OLD");

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint256 timestamp = block.timestamp - secondsAgos[i];
            tickCumulatives[i] = int56(int256(tick) * int256(timestamp));
        }
    }
}

contract MedianStableTwapSettlementOracleTest {
    MedianOracleVm internal constant vm = MedianOracleVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockMedianUniswapV3PoolOracle internal usdcPool;
    MockMedianUniswapV3PoolOracle internal usdtPool;
    MockMedianUniswapV3PoolOracle internal daiPool;
    MedianStableTwapSettlementOracle internal oracle;
    bytes32 internal seriesId;

    uint256 internal constant STRIKE = 1_000e18;
    uint64 internal constant MATURITY_DELAY = 30 days;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 10 ether;

    function setUp() public {
        factory = new EthOptionsFactory();
        usdcPool = new MockMedianUniswapV3PoolOracle();
        usdtPool = new MockMedianUniswapV3PoolOracle();
        daiPool = new MockMedianUniswapV3PoolOracle();

        MedianStableTwapSettlementOracle.PoolConfig[3] memory configs;
        configs[0] = _poolConfig(usdcPool, 2_000e18, false, -100, 100);
        configs[1] = _poolConfig(usdtPool, 2_100e18, false, -100, 100);
        configs[2] = _poolConfig(daiPool, 1_900e18, false, -100, 100);
        oracle = new MedianStableTwapSettlementOracle(address(factory), configs);

        seriesId = factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, oracle);
    }

    function testFactoryRegistersSeriesMetadata() public view {
        (uint64 maturity, uint32 twapWindow, bool registered) = oracle.seriesConfigs(seriesId);

        assertEq(registered ? uint256(1) : uint256(0), 1);
        assertEq(uint256(maturity), block.timestamp + MATURITY_DELAY);
        assertEq(twapWindow, TWAP_WINDOW);
    }

    function testSettlesToMedianStableTwap() public {
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY_DELAY);
        factory.settle(seriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(seriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertEq(settlementPrice, 2_000e18);
    }

    function testMedianIgnoresOneIssuerOutlier() public {
        MedianStableTwapSettlementOracle.PoolConfig[3] memory configs;
        configs[0] = _poolConfig(usdcPool, 2_000e18, false, -100, 100);
        configs[1] = _poolConfig(usdtPool, 2_050e18, false, -100, 100);
        configs[2] = _poolConfig(daiPool, 600e18, false, -100, 100);
        MedianStableTwapSettlementOracle outlierOracle = new MedianStableTwapSettlementOracle(address(factory), configs);
        bytes32 outlierSeriesId =
            factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, outlierOracle);

        vm.warp(block.timestamp + MATURITY_DELAY);
        factory.settle(outlierSeriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(outlierSeriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertEq(settlementPrice, 2_000e18);
    }

    function testMedianIgnoresOneHighIssuerOutlier() public {
        MedianStableTwapSettlementOracle.PoolConfig[3] memory configs;
        configs[0] = _poolConfig(usdcPool, 2_000e18, false, -100, 100);
        configs[1] = _poolConfig(usdtPool, 2_050e18, false, -100, 100);
        configs[2] = _poolConfig(daiPool, 9_000e18, false, -100, 100);
        MedianStableTwapSettlementOracle outlierOracle = new MedianStableTwapSettlementOracle(address(factory), configs);
        bytes32 outlierSeriesId =
            factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, outlierOracle);

        vm.warp(block.timestamp + MATURITY_DELAY);
        factory.settle(outlierSeriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(outlierSeriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertEq(settlementPrice, 2_050e18);
    }

    function testFuzzSettlesToMedianOfThreeStableSources(uint256 rawA, uint256 rawB, uint256 rawC) public {
        uint256 priceA = _boundedPrice(rawA);
        uint256 priceB = _boundedPrice(rawB);
        uint256 priceC = _boundedPrice(rawC);

        MedianStableTwapSettlementOracle.PoolConfig[3] memory configs;
        configs[0] = _poolConfig(usdcPool, priceA, false, -100, 100);
        configs[1] = _poolConfig(usdtPool, priceB, false, -100, 100);
        configs[2] = _poolConfig(daiPool, priceC, false, -100, 100);
        MedianStableTwapSettlementOracle fuzzOracle = new MedianStableTwapSettlementOracle(address(factory), configs);
        bytes32 fuzzSeriesId =
            factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, fuzzOracle);

        vm.warp(block.timestamp + MATURITY_DELAY);
        factory.settle(fuzzSeriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(fuzzSeriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertEq(settlementPrice, _median(priceA, priceB, priceC));
    }

    function testRequiresAllThreeStableSourcesReady() public {
        daiPool.setShouldRevert(true);

        vm.warp(block.timestamp + MATURITY_DELAY);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(seriesId);
    }

    function testRejectsDuplicateSourcePools() public {
        MedianStableTwapSettlementOracle.PoolConfig[3] memory configs;
        configs[0] = _poolConfig(usdcPool, 2_000e18, false, -100, 100);
        configs[1] = _poolConfig(usdcPool, 2_050e18, false, -100, 100);
        configs[2] = _poolConfig(daiPool, 1_900e18, false, -100, 100);

        vm.expectRevert(MedianStableTwapSettlementOracle.InvalidConfig.selector);
        new MedianStableTwapSettlementOracle(address(factory), configs);
    }

    function testRejectsSourceTickOutsideConfiguredBand() public {
        daiPool.setTick(101);

        vm.warp(block.timestamp + MATURITY_DELAY);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(seriesId);
    }

    function testOnlyFactoryCanRegisterSeries() public {
        vm.expectRevert(MedianStableTwapSettlementOracle.NotFactory.selector);
        oracle.registerSeries(bytes32(uint256(123)), uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW);
    }

    function _poolConfig(
        MockMedianUniswapV3PoolOracle pool,
        uint256 priceAtTickZeroWad,
        bool invertPrice,
        int24 minUsableTick,
        int24 maxUsableTick
    ) internal pure returns (MedianStableTwapSettlementOracle.PoolConfig memory) {
        return MedianStableTwapSettlementOracle.PoolConfig({
            pool: IUniswapV3PoolOracleLike(address(pool)),
            priceAtTickZeroWad: priceAtTickZeroWad,
            invertPrice: invertPrice,
            minUsableTick: minUsableTick,
            maxUsableTick: maxUsableTick
        });
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function _boundedPrice(uint256 rawPrice) internal pure returns (uint256) {
        return 1 + (rawPrice % 1_000_000e18);
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
}
