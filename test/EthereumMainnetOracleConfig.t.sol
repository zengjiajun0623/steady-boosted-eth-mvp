// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {EthereumMainnetOracleConfig} from "../src/oracle/EthereumMainnetOracleConfig.sol";
import {MedianStableTwapSettlementOracle} from "../src/oracle/MedianStableTwapSettlementOracle.sol";
import {IUniswapV3PoolOracleLike, UniswapV3TwapSettlementOracle} from "../src/oracle/UniswapV3TwapSettlementOracle.sol";

interface ConfigVm {
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract ConfigMockUniswapV3PoolOracle {
    int24 public tick;

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint256 timestamp = block.timestamp - secondsAgos[i];
            tickCumulatives[i] = int56(int256(tick) * int256(timestamp));
        }
    }
}

contract EthereumMainnetOracleConfigTest {
    ConfigVm internal constant vm = ConfigVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant STRIKE = 1_000e18;
    uint64 internal constant MATURITY_DELAY = 30 days;

    function testMainnetAddressesMatchVerifiedUniswapPool() public pure {
        (address uniswapV3Factory, address pool, address usdc, address weth, uint24 fee) =
            EthereumMainnetOracleConfig.mainnetAddresses();
        EthereumMainnetOracleConfig.OracleConfig memory config = EthereumMainnetOracleConfig.mainnetEthUsdc005();

        assertEq(uniswapV3Factory, 0x1F98431c8aD98523631AE4a59f267346ea31F984);
        assertEq(pool, 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640);
        assertEq(usdc, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
        assertEq(weth, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        assertEq(fee, 500);

        assertEq(config.pool, pool);
        assertEq(config.priceAtTickZeroWad, 1_000_000_000_000_000_000_000_000_000_000);
        assertEq(config.invertPrice ? uint256(1) : uint256(0), 1);
        assertEq(int256(config.minUsableTick), 175_000);
        assertEq(int256(config.maxUsableTick), 221_200);
        assertEq(config.defaultTwapWindow, 72 hours);
        assertEq(config.initialSeriesCapEth, 50 ether);
    }

    function testMainnetStableMedianPoolsMatchVerifiedUniswapPools() public pure {
        (address usdcPool, address usdtPool, address daiPool, address usdc, address usdt, address dai, address weth) =
            EthereumMainnetOracleConfig.mainnetStablePools005();
        EthereumMainnetOracleConfig.MedianOracleConfig memory config =
            EthereumMainnetOracleConfig.mainnetEthStableMedian005();

        assertEq(usdcPool, 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640);
        assertEq(usdtPool, 0x11b815efB8f581194ae79006d24E0d814B7697F6);
        assertEq(daiPool, 0x60594a405d53811d3BC4766596EFD80fd545A270);
        assertEq(usdc, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
        assertEq(usdt, 0xdAC17F958D2ee523a2206206994597C13D831ec7);
        assertEq(dai, 0x6B175474E89094C44Da98b954EedeAC495271d0F);
        assertEq(weth, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

        assertEq(address(config.pools[0].pool), usdcPool);
        assertEq(address(config.pools[1].pool), usdtPool);
        assertEq(address(config.pools[2].pool), daiPool);
        assertEq(config.defaultTwapWindow, 72 hours);
        assertEq(config.initialSeriesCapEth, 50 ether);
    }

    function testMainnetTickConversionReturnsEthUsdcPrice() public {
        (EthOptionsFactory factory, ConfigMockUniswapV3PoolOracle pool, UniswapV3TwapSettlementOracle oracle) =
            _configuredOracle();
        EthereumMainnetOracleConfig.OracleConfig memory config = EthereumMainnetOracleConfig.mainnetEthUsdc005();
        uint64 maturity = uint64(block.timestamp + MATURITY_DELAY);
        bytes32 seriesId = factory.createSeries(STRIKE, maturity, config.defaultTwapWindow, 10 ether, oracle);

        pool.setTick(200_311);
        vm.warp(maturity);
        factory.settle(seriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(seriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertApprox(settlementPrice, 2_000e18, 2e18);
    }

    function testMainnetMedianTickConversionReturnsEthUsdPrice() public {
        EthOptionsFactory factory = new EthOptionsFactory();
        ConfigMockUniswapV3PoolOracle usdcPool = new ConfigMockUniswapV3PoolOracle();
        ConfigMockUniswapV3PoolOracle usdtPool = new ConfigMockUniswapV3PoolOracle();
        ConfigMockUniswapV3PoolOracle daiPool = new ConfigMockUniswapV3PoolOracle();
        EthereumMainnetOracleConfig.MedianOracleConfig memory config =
            EthereumMainnetOracleConfig.mainnetEthStableMedian005();

        config.pools[0].pool = IUniswapV3PoolOracleLike(address(usdcPool));
        config.pools[1].pool = IUniswapV3PoolOracleLike(address(usdtPool));
        config.pools[2].pool = IUniswapV3PoolOracleLike(address(daiPool));
        MedianStableTwapSettlementOracle oracle = new MedianStableTwapSettlementOracle(address(factory), config.pools);
        uint64 maturity = uint64(block.timestamp + MATURITY_DELAY);
        bytes32 seriesId = factory.createSeries(STRIKE, maturity, config.defaultTwapWindow, 10 ether, oracle);

        usdcPool.setTick(200_311);
        usdtPool.setTick(-200_311);
        daiPool.setTick(-76_013);
        vm.warp(maturity);
        factory.settle(seriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(seriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertApprox(settlementPrice, 2_000e18, 3e18);
    }

    function testMainnetConfigRejectsAverageTickOutsidePilotBand() public {
        (EthOptionsFactory factory, ConfigMockUniswapV3PoolOracle pool, UniswapV3TwapSettlementOracle oracle) =
            _configuredOracle();
        EthereumMainnetOracleConfig.OracleConfig memory config = EthereumMainnetOracleConfig.mainnetEthUsdc005();

        uint64 highPriceMaturity = uint64(block.timestamp + MATURITY_DELAY);
        bytes32 highPriceSeries =
            factory.createSeries(STRIKE, highPriceMaturity, config.defaultTwapWindow, 10 ether, oracle);
        pool.setTick(config.minUsableTick - 1);
        vm.warp(highPriceMaturity);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(highPriceSeries);

        uint64 lowPriceMaturity = uint64(block.timestamp + MATURITY_DELAY + 1 days);
        bytes32 lowPriceSeries =
            factory.createSeries(STRIKE, lowPriceMaturity, config.defaultTwapWindow, 10 ether, oracle);
        pool.setTick(config.maxUsableTick + 1);
        vm.warp(lowPriceMaturity);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(lowPriceSeries);
    }

    function _configuredOracle()
        internal
        returns (EthOptionsFactory factory, ConfigMockUniswapV3PoolOracle pool, UniswapV3TwapSettlementOracle oracle)
    {
        factory = new EthOptionsFactory();
        pool = new ConfigMockUniswapV3PoolOracle();
        EthereumMainnetOracleConfig.OracleConfig memory config = EthereumMainnetOracleConfig.mainnetEthUsdc005();
        oracle = new UniswapV3TwapSettlementOracle(
            address(factory),
            IUniswapV3PoolOracleLike(address(pool)),
            config.priceAtTickZeroWad,
            config.invertPrice,
            config.minUsableTick,
            config.maxUsableTick
        );
    }

    function assertApprox(uint256 actual, uint256 expected, uint256 tolerance) internal pure {
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        require(diff <= tolerance, "outside tolerance");
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(int256 actual, int256 expected) internal pure {
        require(actual == expected, "int mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}
