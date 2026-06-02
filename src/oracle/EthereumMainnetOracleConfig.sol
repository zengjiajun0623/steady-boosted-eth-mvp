// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MedianStableTwapSettlementOracle} from "./MedianStableTwapSettlementOracle.sol";
import {IUniswapV3PoolOracleLike, UniswapV3TwapSettlementOracle} from "./UniswapV3TwapSettlementOracle.sol";

/// @notice Mainnet ETH/stable TWAP oracle parameters for the first Ethereum pilot.
/// @dev Pool/address facts were verified by calling UniswapV3Factory.getPool
/// on Ethereum mainnet and checking the pool's token0/token1/fee methods.
library EthereumMainnetOracleConfig {
    struct OracleConfig {
        address pool;
        uint256 priceAtTickZeroWad;
        bool invertPrice;
        int24 minUsableTick;
        int24 maxUsableTick;
        uint32 defaultTwapWindow;
        uint256 initialSeriesCapEth;
    }

    struct MedianOracleConfig {
        MedianStableTwapSettlementOracle.PoolConfig[3] pools;
        uint32 defaultTwapWindow;
        uint256 initialSeriesCapEth;
    }

    function mainnetAddresses()
        internal
        pure
        returns (address uniswapV3Factory, address pool, address usdc, address weth, uint24 fee)
    {
        uniswapV3Factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        pool = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
        usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        fee = 500;
    }

    function mainnetEthUsdc005() internal pure returns (OracleConfig memory config) {
        (, address pool,,,) = mainnetAddresses();
        config = OracleConfig({
            pool: pool,
            priceAtTickZeroWad: 1_000_000_000_000_000_000_000_000_000_000,
            invertPrice: true,
            minUsableTick: 175_000,
            maxUsableTick: 221_200,
            defaultTwapWindow: 72 hours,
            initialSeriesCapEth: 50 ether
        });
    }

    function mainnetStablePools005()
        internal
        pure
        returns (address usdcPool, address usdtPool, address daiPool, address usdc, address usdt, address dai, address weth)
    {
        usdcPool = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
        usdtPool = 0x11b815efB8f581194ae79006d24E0d814B7697F6;
        daiPool = 0x60594a405d53811d3BC4766596EFD80fd545A270;
        usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        usdt = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        dai = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    }

    function mainnetEthStableMedian005() internal pure returns (MedianOracleConfig memory config) {
        (address usdcPool, address usdtPool, address daiPool,,,,) = mainnetStablePools005();

        config.pools[0] = MedianStableTwapSettlementOracle.PoolConfig({
            pool: IUniswapV3PoolOracleLike(usdcPool),
            priceAtTickZeroWad: 1_000_000_000_000_000_000_000_000_000_000,
            invertPrice: true,
            minUsableTick: 175_000,
            maxUsableTick: 221_200
        });
        config.pools[1] = MedianStableTwapSettlementOracle.PoolConfig({
            pool: IUniswapV3PoolOracleLike(usdtPool),
            priceAtTickZeroWad: 1_000_000_000_000_000_000_000_000_000_000,
            invertPrice: false,
            minUsableTick: -221_200,
            maxUsableTick: -175_000
        });
        config.pools[2] = MedianStableTwapSettlementOracle.PoolConfig({
            pool: IUniswapV3PoolOracleLike(daiPool),
            priceAtTickZeroWad: 1_000_000_000_000_000_000,
            invertPrice: true,
            minUsableTick: -106_500,
            maxUsableTick: -53_000
        });
        config.defaultTwapWindow = 72 hours;
        config.initialSeriesCapEth = 50 ether;
    }

    function deployMainnetEthUsdc005(address optionsFactory) internal returns (UniswapV3TwapSettlementOracle oracle) {
        OracleConfig memory config = mainnetEthUsdc005();
        oracle = new UniswapV3TwapSettlementOracle(
            optionsFactory,
            IUniswapV3PoolOracleLike(config.pool),
            config.priceAtTickZeroWad,
            config.invertPrice,
            config.minUsableTick,
            config.maxUsableTick
        );
    }

    function deployMainnetEthStableMedian005(address optionsFactory)
        internal
        returns (MedianStableTwapSettlementOracle oracle)
    {
        MedianOracleConfig memory config = mainnetEthStableMedian005();
        oracle = new MedianStableTwapSettlementOracle(optionsFactory, config.pools);
    }
}
